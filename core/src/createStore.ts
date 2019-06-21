import automerge, { DocSet, Message, Change } from 'automerge'
import hypercore from 'hypercore'
import db from 'random-access-idb'
import * as Redux from 'redux'
import signalhub from 'signalhub'
import webrtcSwarm from 'webrtc-swarm'
import { DeepPartial } from 'redux'

import { actions } from './actions'
import { adaptReducer } from './adaptReducer'
import { automergify } from './automergify'
import { DEFAULT_PEER_HUBS } from './constants'
import { Connection } from './connection'
import debug from './debug'
import { getMiddleware } from './getMiddleware'
import { getKeys } from './keyManager'
import { mockCrypto } from './mockCrypto'
import { CreateStoreOptions } from './types'

const log = debug('cevitxe:createStore')

const valueEncoding = 'utf-8'
const crypto = mockCrypto

export const createStore = async <T>({
  databaseName = 'cevitxe-data',
  peerHubs = DEFAULT_PEER_HUBS,
  proxyReducer,
  defaultState = {},
  middlewares = [],
  discoveryKey,
}: CreateStoreOptions<T>): Promise<Redux.Store> => {
  const { key, secretKey } = getKeys(discoveryKey)

  // Init an indexedDB
  const storeName = `${databaseName}-${discoveryKey.substr(0, 12)}`
  const storage = db(storeName)

  // Create a new hypercore feed
  const feed: Feed<string> = hypercore(storage, key, { secretKey, valueEncoding, crypto })
  feed.on('error', (err: any) => console.error(err))

  const feedReady = new Promise(yes => feed.on('ready', () => yes()))
  await feedReady
  log.groupCollapsed(`feed ready; ${feed.length} stored changes`)

  const state: Partial<T> =
    feed.length > 0 // is there anything in the feed already? (e.g. coming from storage)
      ? await rehydrateFrom(feed) // if so, rehydrate state from that
      : initialize(feed, defaultState) // if not, initialize

  // Create Redux store
  const reducer = adaptReducer(proxyReducer)
  const enhancer = Redux.applyMiddleware(...middlewares, getMiddleware(feed))
  const store = Redux.createStore(reducer, state as DeepPartial<DocSet<T>>, enhancer)

  const connections: Connection<Partial<T>>[] = []

  // Now that we've initialized the store, it's safe to subscribe to the feed without worrying about race conditions
  const hub = signalhub(discoveryKey, peerHubs)
  const swarm = webrtcSwarm(hub)

  log('joined swarm', key)
  swarm.on('peer', (peer: any, id: any) => {
    log('peer', id, peer)
    connections.push(new Connection(store.getState(), peer))
  })

  const start = feed.length // skip any items we already read when initializing
  const stream = feed.createReadStream({ start, live: true })

  // Listen for new items the feed and dispatch them to our redux store
  stream.on('data', (_data: string) => {
    const message = JSON.parse(_data) as Message<T>

    // don't confuse `message: {docId, clock, changes}` (generated by automerge.Connection)
    // with `change.message: string` (optionally provided to automerge.change())
    const changeMessages = (message.changes || []).map((c: Change<T>) => c.message)
    log('dispatch from feed', changeMessages)

    connections.forEach(connection => store.dispatch(actions.recieveMessage(message, connection)))
  })
  log.groupEnd()
  return store
}

const rehydrateFrom = async <T>(feed: Feed<string>): Promise<T> => {
  log('rehydrating from stored messages')
  const batch = new Promise(yes => feed.getBatch(0, feed.length, (_, data) => yes(data)))
  const data = (await batch) as string[]
  const messages = data.map(d => JSON.parse(d))
  let state = automerge.init<T>()
  messages.forEach(m => (state = automerge.applyChanges(state, m.changes)))
  return state
}

const initialize = <T>(feed: Feed<string>, defaultState: T): T => {
  log('nothing in storage; initializing')
  const state = automergify(defaultState)
  const changes = automerge.getChanges(automerge.init(), state)
  const message = { clock: {}, changes }
  feed.append(JSON.stringify(message))
  return state
}

export const joinStore = createStore