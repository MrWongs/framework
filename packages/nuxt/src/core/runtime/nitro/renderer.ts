import { createRenderer } from 'vue-bundle-renderer/runtime'
import type { RenderResponse } from 'nitropack'
import type { Manifest } from 'vite'
import { CompatibilityEvent, readBody, getQuery } from 'h3'
import devalue from '@nuxt/devalue'
import destr from 'destr'
import { renderToString as _renderToString } from 'vue/server-renderer'
import type { NuxtApp, NuxtSSRContext } from '#app'
import { useRuntimeConfig, useNitroApp, defineRenderHandler } from '#internal/nitro'

// @ts-ignore
import { buildAssetsURL } from '#paths'

export interface NuxtRenderHTMLContext {
  island?: boolean
  htmlAttrs: string[]
  head: string[]
  bodyAttrs: string[]
  bodyPreprend: string[]
  body: string[]
  bodyAppend: string[]
}

export interface NuxtIslandContext {
  id?: string
  url?: string
  format?: 'html' | 'json'
  name: string
  props?: Record<string, any>
}

export interface NuxtIslandResponse {
  id?: string
  html: string
  state: Record<string, any>
  tags: [tag: string, attrs?: Record<string, string>][]
}

export interface NuxtRenderResponse {
  body: string,
  statusCode: number,
  statusMessage?: string,
  headers: Record<string, string>
}

interface ClientManifest { }

// @ts-ignore
const getClientManifest: () => Promise<Manifest> = () => import('#build/dist/server/client.manifest.mjs')
  .then(r => r.default || r)
  .then(r => typeof r === 'function' ? r() : r) as Promise<ClientManifest>

// @ts-ignore
const getServerEntry = () => import('#build/dist/server/server.mjs').then(r => r.default || r)

// -- SSR Renderer --
const getSSRRenderer = lazyCachedFunction(async () => {
  // Load client manifest
  const manifest = await getClientManifest()
  if (!manifest) { throw new Error('client.manifest is not available') }

  // Load server bundle
  const createSSRApp = await getServerEntry()
  if (!createSSRApp) { throw new Error('Server bundle is not available') }

  const options = {
    manifest,
    renderToString,
    buildAssetsURL
  }
  // Create renderer
  const renderer = createRenderer(createSSRApp, options)

  type RenderToStringParams = Parameters<typeof _renderToString>
  async function renderToString (input: RenderToStringParams[0], context: RenderToStringParams[1]) {
    const html = await _renderToString(input, context)
    // In development with vite-node, the manifest is on-demand and will be available after rendering
    if (process.dev && process.env.NUXT_VITE_NODE_OPTIONS) {
      renderer.rendererContext.updateManifest(await getClientManifest())
    }
    return `<div id="__nuxt">${html}</div>`
  }

  return renderer
})

// -- SPA Renderer --
const getSPARenderer = lazyCachedFunction(async () => {
  const manifest = await getClientManifest()

  const options = {
    manifest,
    renderToString: () => '<div id="__nuxt"></div>',
    buildAssetsURL
  }
  // Create SPA renderer and cache the result for all requests
  const renderer = createRenderer(() => () => { }, options)
  const result = await renderer.renderToString({})

  const renderToString = (ssrContext: NuxtSSRContext) => {
    const config = useRuntimeConfig()
    ssrContext!.payload = {
      serverRendered: false,
      config: {
        public: config.public,
        app: config.app
      },
      data: {},
      state: {}
    }
    ssrContext!.renderMeta = ssrContext!.renderMeta ?? (() => ({}))
    return Promise.resolve(result)
  }

  return { renderToString }
})

async function getIslandContext (event: CompatibilityEvent): Promise<NuxtIslandContext> {
  // TODO: Strict validation for url
  const url = event.req.url?.substring('/__nuxt_island'.length + 1) || ''
  const [componentName, hashId] = url.split('?')[0].split(':')

  // TODO: Validate context
  const context = event.req.method === 'GET' ? getQuery(event) : await readBody(event)

  const ctx: NuxtIslandContext = {
    url: '/',
    ...context,
    id: hashId,
    name: componentName,
    props: destr(context.props) || {}
  }

  return ctx
}

export default defineRenderHandler(async (event) => {
  const nitroApp = useNitroApp()

  // Whether we're rendering an error page
  const ssrError = event.req.url?.startsWith('/__nuxt_error') ? getQuery(event) as Exclude<NuxtApp['payload']['error'], Error> : null
  const islandContext = event.req.url?.startsWith('/__nuxt_island') ? await getIslandContext(event) : undefined
  const url: string = ssrError?.url as string || islandContext?.url || event.req.url!

  // Initialize ssr context
  const ssrContext: NuxtSSRContext = {
    url,
    event,
    req: event.req,
    res: event.res,
    runtimeConfig: useRuntimeConfig() as NuxtSSRContext['runtimeConfig'],
    noSSR: !!event.req.headers['x-nuxt-no-ssr'],
    error: !!ssrError,
    nuxt: undefined!, /* NuxtApp */
    payload: ssrError ? { error: ssrError } as NuxtSSRContext['payload'] : undefined!,
    islandContext
  }

  // Render app
  const renderer = (process.env.NUXT_NO_SSR || ssrContext.noSSR) ? await getSPARenderer() : await getSSRRenderer()
  const _rendered = await renderer.renderToString(ssrContext).catch((err) => {
    if (!ssrError) {
      throw err
    }
  })
  await ssrContext.nuxt?.hooks.callHook('app:rendered', { ssrContext })

  // Handle errors
  if (!_rendered) {
    return undefined!
  }
  if (ssrContext.payload?.error && !ssrError) {
    throw ssrContext.payload.error
  }

  // Render meta
  const renderedMeta = await ssrContext.renderMeta?.() ?? {}

  // Create render context
  const htmlContext: NuxtRenderHTMLContext = {
    island: Boolean(islandContext),
    htmlAttrs: normalizeChunks([renderedMeta.htmlAttrs]),
    head: normalizeChunks([
      renderedMeta.headTags,
      _rendered.renderResourceHints(),
      _rendered.renderStyles(),
      ssrContext.styles
    ]),
    bodyAttrs: normalizeChunks([renderedMeta.bodyAttrs!]),
    bodyPreprend: normalizeChunks([
      renderedMeta.bodyScriptsPrepend,
      ssrContext.teleports?.body
    ]),
    body: islandContext
      ? []
      : [
          _rendered.html
        ],
    bodyAppend: normalizeChunks([
      `<script>window.__NUXT__=${devalue(ssrContext.payload)}</script>`,
      _rendered.renderScripts(),
      // Note: bodyScripts may contain tags other than <script>
      renderedMeta.bodyScripts
    ])
  }

  // Allow hooking into the rendered result
  await nitroApp.hooks.callHook('render:html', htmlContext, { event })

  // Response for component islands
  if (islandContext && islandContext.format !== 'html') {
    const islandResponse: NuxtIslandResponse = {
      id: islandContext.id,
      html: ssrContext.teleports!['nuxt-island'].replace(/<!--.*-->/g, ''),
      state: ssrContext.payload.state,
      tags: htmlContext.head.flatMap(head => extractHTMLTags(head))
    }

    await nitroApp.hooks.callHook('render:island', islandResponse, { event, islandContext })

    const response: RenderResponse = {
      body: JSON.stringify(islandResponse, null, 2),
      statusCode: event.res.statusCode,
      statusMessage: event.res.statusMessage,
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'x-powered-by': 'Nuxt'
      }
    }
    return response
  }

  // Construct HTML response
  const response: RenderResponse = {
    body: renderHTMLDocument(htmlContext),
    statusCode: event.res.statusCode,
    statusMessage: event.res.statusMessage,
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'x-powered-by': 'Nuxt'
    }
  }

  return response
})

function lazyCachedFunction<T> (fn: () => Promise<T>): () => Promise<T> {
  let res: Promise<T> | null = null
  return () => {
    if (res === null) {
      res = fn().catch((err) => { res = null; throw err })
    }
    return res
  }
}

function normalizeChunks (chunks: (string | undefined)[]) {
  return chunks.filter(Boolean).map(i => i!.trim())
}

function joinTags (tags: string[]) {
  return tags.join('')
}

function joinAttrs (chunks: string[]) {
  return chunks.join(' ')
}

function renderHTMLDocument (html: NuxtRenderHTMLContext) {
  return `<!DOCTYPE html>
<html ${joinAttrs(html.htmlAttrs)}>
<head>${joinTags(html.head)}</head>
<body ${joinAttrs(html.bodyAttrs)}>${joinTags(html.bodyPreprend)}${joinTags(html.body)}${joinTags(html.bodyAppend)}</body>
</html>`
}

// TOOD: Move to external library
const HTML_TAG_RE = /<(?<tag>[a-z]+)(?<rawAttrs> [^>]*)>/g
const HTML_TAG_ATTR_RE = /(?<name>[a-z]+)="(?<value>[^"]*)"/g
function extractHTMLTags (html: string) {
  const tags: [tag: string, attrs?: Record<string, string>][] = []
  for (const tagMatch of html.matchAll(HTML_TAG_RE)) {
    const attrs = {} as Record<string, string>
    for (const attraMatch of tagMatch.groups!.rawAttrs.matchAll(HTML_TAG_ATTR_RE)) {
      attrs[attraMatch.groups!.name] = attraMatch.groups!.value
    }
    tags.push([tagMatch.groups!.tag, attrs])
  }
  return tags
}
