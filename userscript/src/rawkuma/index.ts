import { createEffect, onCleanup } from 'solid-js'
import type { Translator } from '../main'
import { resizeToSubmit } from '../utils/core'
import { targetLang } from '../utils/storage'

const readerSelector = '[data-image-data="1"]'
const readerImages = `${readerSelector} > img, ${readerSelector} > picture > img`
const settingsKey = 'rawkuma-private-translator'
const defaultOrigin = 'http://127.0.0.1:8000'
const inpaintingSize = 1024
const defaultLanguage = 'CHS'
const recentTimingLimit = 5
const chapterConcurrency = 2
const jobPollInterval = 250

interface Connection {
  endpoint: string
  key: string
}

interface Page {
  image: HTMLImageElement
  source: string
  translated?: Awaited<ReturnType<typeof translatedImage>>
  failed?: boolean
}

type DownloadedImage = Awaited<ReturnType<typeof downloadPage>>
type PageResult = { image: Blob, serverMs?: number }

function translationEndpoint(address: string): string {
  const url = new URL(address)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash)
    throw new Error('Enter an HTTPS server URL or a local HTTP URL.')

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/translate/with-form/image`
  return url.href
}

async function configureConnection(): Promise<void> {
  const address = prompt('Private Manga Image Translator server URL', defaultOrigin)
  if (address === null)
    return
  const endpoint = translationEndpoint(address.trim())
  const key = prompt('Paste the Manga Image Translator pairing key')?.trim()
  if (key)
    await GMP.setValue(settingsKey, { endpoint, key })
}

function imageSource(image: HTMLImageElement): string | undefined {
  for (const candidate of [image.getAttribute('data-src'), image.currentSrc, image.getAttribute('src')]) {
    if (!candidate)
      continue
    try {
      const url = new URL(candidate, location.href)
      if (url.protocol === 'https:' && ['cdn.rawkuma.com', 'cdn.rawkuma.net'].includes(url.hostname)
          && !url.username && !url.password)
        return url.href
    }
    catch { /* Ignore an invalid image URL. */ }
  }
  return undefined
}

async function downloadPage(source: string) {
  const original = await GMP.xmlHttpRequest({
    method: 'GET', url: source, responseType: 'blob', anonymous: true, timeout: 45000,
  })
  if (original.status !== 200 || !original.response?.size)
    throw new Error(`Could not load the chapter image (HTTP ${original.status}).`)

  const extension = new URL(source).pathname.split('.').pop() || 'jpg'
  return resizeToSubmit(original.response, extension)
}

function setTranslationConfig(data: FormData, language: string) {
  data.set('config', JSON.stringify({
    translator: { translator: 'siwc', target_lang: language },
    inpainter: { inpainting_size: inpaintingSize },
  }))
}

async function sendTranslation(
  endpoint: string,
  key: string,
  method: 'POST' | 'GET' | 'DELETE',
  data?: FormData,
) {
  const options = {
    method, url: endpoint, responseType: 'blob' as const,
    anonymous: true, timeout: method === 'POST' ? 240000 : 15000, redirect: 'error',
    headers: { 'X-Manga-SIWC-Key': key },
    data,
  }
  // @ts-expect-error Userscript managers accept FormData. The upstream type declares a string.
  const response = await GMP.xmlHttpRequest(options)
  if (response.finalUrl && response.finalUrl !== endpoint)
    throw new Error('The translator redirected the request. Use its final server URL.')
  return response
}

async function translationError(status: number, result?: Blob) {
  const failure = await result?.text().then(text => JSON.parse(text)).catch(() => null)
  return new Error(typeof failure?.detail === 'string' ? failure.detail : `The translator returned an invalid response (HTTP ${status}).`)
}

async function translatePage({ blob, suffix }: DownloadedImage, connection: Connection, language: string): Promise<PageResult> {
  const data = new FormData()
  data.append('image', blob, `page.${suffix}`)
  setTranslationConfig(data, language)
  const response = await sendTranslation(connection.endpoint, connection.key, 'POST', data)
  const result = response.response as Blob
  if (response.status !== 200 || result?.type !== 'image/png')
    throw await translationError(response.status, result)
  return { image: result }
}

async function translateQueuedPage(
  { blob, suffix }: DownloadedImage,
  connection: Connection,
  language: string,
  keepWaiting: () => boolean,
): Promise<PageResult | undefined> {
  const data = new FormData()
  data.append('image', blob, `page.${suffix}`)
  setTranslationConfig(data, language)
  const jobsUrl = `${connection.endpoint}/jobs`
  const queued = await sendTranslation(jobsUrl, connection.key, 'POST', data)
  if (queued.status === 404)
    return undefined
  const receipt = queued.response as Blob
  if (queued.status !== 202 || !receipt)
    throw await translationError(queued.status, receipt)
  const job = JSON.parse(await receipt.text())
  if (typeof job?.id !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(job.id))
    throw new Error('The translator returned an invalid page job.')

  const jobUrl = `${jobsUrl}/${job.id}`
  const deadline = performance.now() + 240000
  while (keepWaiting() && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, jobPollInterval))
    if (!keepWaiting())
      break
    const response = await sendTranslation(jobUrl, connection.key, 'GET')
    if (response.status === 202)
      continue
    const result = response.response as Blob
    if (response.status === 200 && result?.type === 'image/png') {
      const duration = response.responseHeaders?.match(/^x-manga-server-ms:\s*(\d+)\s*$/im)
      void sendTranslation(jobUrl, connection.key, 'DELETE').catch(() => {})
      return { image: result, serverMs: duration ? Number(duration[1]) : undefined }
    }
    if (response.status === 500)
      void sendTranslation(jobUrl, connection.key, 'DELETE').catch(() => {})
    throw await translationError(response.status, result)
  }
  throw new Error(keepWaiting() ? 'The translation request timed out.' : 'The page was closed.')
}

async function translatedImage(image: HTMLImageElement, translated: Blob) {
  const url = URL.createObjectURL(translated)
  try {
    // Decode offscreen so lazy reader images can finish below the viewport.
    const preview = new Image()
    preview.src = url
    await preview.decode()
  }
  catch {
    URL.revokeObjectURL(url)
    throw new Error('Could not display the translated image.')
  }
  const src = image.getAttribute('src')
  const picture = image.closest('picture')
  const responsive = [image, ...Array.from(picture?.querySelectorAll('source') ?? [])]
    .map(node => ({ node, value: node.getAttribute('srcset') }))

  function show() {
    responsive.forEach(({ node }) => node.removeAttribute('srcset'))
    image.src = url
  }

  function hide() {
    if (image.getAttribute('src') !== url)
      return
    if (src === null)
      image.removeAttribute('src')
    else
      image.setAttribute('src', src)
    for (const { node, value } of responsive) {
      if (value !== null)
        node.setAttribute('srcset', value)
    }
  }

  function dispose() {
    hide()
    URL.revokeObjectURL(url)
  }

  return { url, show, hide, dispose }
}

function button() {
  const element = document.createElement('button')
  element.type = 'button'
  element.style.cssText = 'background:#222;color:#fff;border:1px solid #777;border-radius:5px;padding:5px 10px'
  return element
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Translation failed. Try again.'
}

function mountChapter() {
  const pages = new Map<HTMLImageElement, Page>()
  const recentTimings: { page: Page, elapsedMs: number, downloadMs: number, requestMs: number, serverMs?: number }[] = []
  const toolbar = document.createElement('div')
  toolbar.style.cssText = 'position:sticky;top:0;z-index:60;width:100%;box-sizing:border-box;padding:8px 12px;background:#171717;color:#fff;border-bottom:1px solid #555;font:14px system-ui'
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:.5rem;overflow-wrap:anywhere'
  const translate = button()
  const toggle = button()
  const status = document.createElement('span')
  status.setAttribute('role', 'status')
  row.append(translate, toggle, status)
  const progress = document.createElement('progress')
  progress.setAttribute('aria-label', 'Chapter translation progress')
  progress.style.cssText = 'display:block;width:100%;height:8px;margin-top:6px;accent-color:#6aa7ff'
  const timings = document.createElement('div')
  timings.style.cssText = 'margin-top:4px;color:#ddd;font-variant-numeric:tabular-nums'
  timings.hidden = true
  toolbar.append(row, progress, timings)

  const active = new Set<Page>()
  let running = false
  let stopping = false
  let disposed = false
  let showTranslations = true
  let translatedLanguage: string | undefined
  let notice = ''

  function updateToolbar() {
    const chapter = [...pages.values()]
    const complete = chapter.filter(page => page.translated).length
    const failed = chapter.filter(page => page.failed).length
    const sameLanguage = translatedLanguage === (targetLang() || defaultLanguage)
    const finished = sameLanguage && complete === pages.size
    const label = running
      ? (stopping ? 'Stopping…' : 'Stop after current pages')
      : complete && finished
        ? 'Chapter translated'
        : complete && sameLanguage ? 'Translate remaining pages' : 'Translate chapter'
    const toggleLabel = showTranslations ? 'Show originals' : 'Show translations'
    const currentPages = chapter.flatMap((page, index) => active.has(page) ? [index + 1] : [])
    const current = currentPages.length
      ? ` · Processing page${currentPages.length > 1 ? 's' : ''} ${currentPages.join(', ')}`
      : ''
    const detail = notice ? ` · ${notice}` : ''
    const text = pages.size
      ? `${complete} of ${pages.size} pages translated${failed ? ` · ${failed} failed` : ''}${current}${detail}`
      : 'Waiting for chapter images…'

    if (translate.textContent !== label)
      translate.textContent = label
    if (toggle.textContent !== toggleLabel)
      toggle.textContent = toggleLabel
    if (status.textContent !== text)
      status.textContent = text
    translate.disabled = running ? stopping : !pages.size || finished
    toggle.hidden = complete === 0
    toggle.disabled = running
    progress.max = Math.max(1, pages.size)
    progress.value = complete

    const recent = recentTimings.flatMap(({ page, ...timing }) => {
      const index = chapter.indexOf(page)
      return index < 0 ? [] : [{ label: `Page ${index + 1}`, ...timing }]
    })
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
    const timingText = recent.length
      ? `Recent timings · ${recent.map(({ label, elapsedMs }) => `${label} ${seconds(elapsedMs)}`).join(' · ')}`
      : ''
    if (timings.textContent !== timingText)
      timings.textContent = timingText
    timings.title = recent.map(({ label, downloadMs, requestMs, serverMs }) =>
      `${label} · Download and preparation ${seconds(downloadMs)} · Request ${seconds(requestMs)}${serverMs === undefined ? '' : ` · Server ${seconds(serverMs)}`}`,
    ).join('\n')
    timings.hidden = !recent.length
  }

  function scan() {
    const reader = document.querySelector(readerSelector)
    if (reader && toolbar.parentElement !== reader)
      reader.prepend(toolbar)

    const images = Array.from(document.querySelectorAll<HTMLImageElement>(readerImages))
    const currentImages = new Set(images)
    for (const [image, page] of pages) {
      if (!currentImages.has(image)) {
        page.translated?.dispose()
        pages.delete(image)
      }
    }
    for (const image of images) {
      const existing = pages.get(image)
      if (existing?.translated?.url && image.getAttribute('src') === existing.translated.url)
        continue
      const source = imageSource(image)
      if (source && existing?.source !== source) {
        existing?.translated?.dispose()
        pages.set(image, { image, source })
      }
    }
    updateToolbar()
  }

  function setVisible(visible: boolean) {
    showTranslations = visible
    for (const { translated } of pages.values()) {
      if (visible)
        translated?.show()
      else
        translated?.hide()
    }
  }

  async function runChapter() {
    running = true
    stopping = false
    notice = ''
    pages.forEach(page => { page.failed = false })
    updateToolbar()
    try {
      const savedConnection: Connection | undefined = await GMP.getValue(settingsKey)
      if (!savedConnection)
        throw new Error('Set your server URL and pairing key from the userscript menu.')
      const connection = savedConnection
      if (disposed || stopping)
        return
      const language = targetLang() || defaultLanguage
      if (translatedLanguage && translatedLanguage !== language) {
        recentTimings.length = 0
        for (const page of pages.values()) {
          page.translated?.dispose()
          page.translated = undefined
        }
      }
      translatedLanguage = language
      setVisible(true)
      const attempted = new Set<Page>()
      let translationFailed = false

      function prefetchNext() {
        const page = [...pages.values()].find(page => !page.translated && !attempted.has(page))
        if (!page)
          return undefined
        attempted.add(page)
        const startedAt = performance.now()
        const download = downloadPage(page.source).then(
          asset => ({ asset, downloadMs: performance.now() - startedAt, error: undefined }),
          error => ({ asset: undefined, downloadMs: 0, error: errorMessage(error) }),
        )
        return { page, download }
      }

      let useJobQueue = true
      let next: ReturnType<typeof prefetchNext>

      async function submitPage(asset: DownloadedImage) {
        if (useJobQueue) {
          const result = await translateQueuedPage(asset, connection, language, () => !disposed)
          if (result)
            return result
          useJobQueue = false
        }
        return translatePage(asset, connection, language)
      }

      async function translatePages() {
        while (!stopping && !disposed && !translationFailed) {
          const current = next ?? prefetchNext()
          next = undefined
          if (!current)
            return

          const { page } = current
          active.add(page)
          updateToolbar()
          try {
            const { asset, downloadMs, error } = await current.download
            if (stopping || disposed || translationFailed)
              return
            if (pages.get(page.image) !== page)
              continue
            if (!asset) {
              page.failed = true
              notice = error || 'Could not download a page.'
              continue
            }

            const startedAt = performance.now()
            const pending = submitPage(asset)
            next ??= prefetchNext()
            const result = await pending
            const requestMs = performance.now() - startedAt
            if (disposed || pages.get(page.image) !== page)
              continue
            const decodeStartedAt = performance.now()
            const translated = await translatedImage(page.image, result.image)
            if (disposed || pages.get(page.image) !== page) {
              translated.dispose()
              continue
            }
            page.translated = translated
            translated.show()
            const elapsedMs = downloadMs + requestMs + (performance.now() - decodeStartedAt)
            recentTimings.unshift({ page, elapsedMs, downloadMs, requestMs, serverMs: result.serverMs })
            if (recentTimings.length > recentTimingLimit)
              recentTimings.pop()
          }
          catch (error) {
            if (!disposed && pages.get(page.image) === page) {
              page.failed = true
              if (!translationFailed)
                notice = errorMessage(error)
              translationFailed = true
            }
          }
          finally {
            active.delete(page)
            if (!disposed)
              updateToolbar()
          }
        }
      }

      await Promise.all(Array.from({ length: chapterConcurrency }, () => translatePages()))
      if (stopping && !translationFailed)
        notice = 'Stopped.'
    }
    catch (error) {
      notice = errorMessage(error)
    }
    finally {
      running = false
      if (!disposed)
        updateToolbar()
    }
  }

  translate.addEventListener('click', (event) => {
    if (!event.isTrusted || translate.disabled)
      return
    if (running) {
      stopping = true
      updateToolbar()
    }
    else {
      scan()
      void runChapter()
    }
  })
  toggle.addEventListener('click', (event) => {
    if (event.isTrusted && !toggle.disabled) {
      setVisible(!showTranslations)
      updateToolbar()
    }
  })

  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src'] })
  scan()
  createEffect(updateToolbar)
  onCleanup(() => {
    disposed = true
    observer.disconnect()
    pages.forEach(page => page.translated?.dispose())
    toolbar.remove()
  })
}

export function isRawkumaChapter(url: URL): boolean {
  return url.origin === 'https://rawkuma.net' && /^\/manga\/[^/]+\/chapter-[^/]+\/?$/.test(url.pathname)
}

const rawkuma: Translator = {
  match: isRawkumaChapter,
  mount() {
    mountChapter()
    return {}
  },
}

export function registerRawkumaSettings() {
  if (location.origin === 'https://rawkuma.net') {
    void GMP.registerMenuCommand('Configure Rawkuma translator', () => {
      void configureConnection().catch((error: Error) => alert(error.message))
    })
  }
}

export default rawkuma
