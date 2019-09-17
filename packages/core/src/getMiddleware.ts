import A from 'automerge'
import debug from 'debug'
import { collection } from './collection'
import { DELETE_COLLECTION, DELETE_ITEM, RECEIVE_MESSAGE_FROM_PEER } from './constants'
import { MiddlewareFactory } from './types'

const log = debug('cevitxe:middleware')

interface DocMap {
  [key: string]: A.Doc<any>
}

export const getMiddleware: MiddlewareFactory = (feed, docSet, proxyReducer) => {
  return store => next => action => {
    // BEFORE CHANGES

    // detect which documents will be changed and cache them
    const affectedDocs: DocMap = {} // cache for docs that will be changed
    const removedDocs: string[] = [] // list of docs that will be removed

    const functionMap = proxyReducer(action)
    if (functionMap) {
      for (let docId in functionMap) {
        const fn = functionMap[docId]
        if (fn === DELETE_COLLECTION) {
          const collectionName = collection.getCollectionName(docId)
          const docIds = collection(collectionName).getKeys(store.getState())
          for (const itemDocId in docIds) removedDocs.push(itemDocId)
          console.log({ collectionName, docIds, removedDocs })

          // mark collection index as changed since we're no longer removing it on collection drop
          // affectedDocs[docId] = docSet.getDoc(docId) || A.init() // If doc didn't exist before, it's a new doc
        } else if (fn === DELETE_ITEM) {
          removedDocs.push(docId)
        } else if (typeof fn === 'function') {
          affectedDocs[docId] = docSet.getDoc(docId) || A.init() // If doc didn't exist before, it's a new doc
        }
      }
    }

    // CHANGES

    const newState = next(action)

    // AFTER CHANGES

    log('%o', { action })

    // collect document changes for persistence
    const changeSets = []
    if (action.type === RECEIVE_MESSAGE_FROM_PEER) {
      // for changes coming from peer, we already have the Automerge changes, so just persist them
      const { docId, changes } = action.payload.message
      changeSets.push({ docId, changes })
    } else {
      // for insert/update, we generate the changes by comparing each document before & after
      for (const docId in affectedDocs) {
        const oldDoc = affectedDocs[docId]
        const newDoc = docSet.getDoc(docId)
        const changes = A.getChanges(oldDoc, newDoc)
        if (changes.length > 0) changeSets.push({ docId, changes })
      }
      // for remove actions, we've made a list, so we just add a flag for each
      for (const docId of removedDocs) changeSets.push({ docId, changes: [], isDelete: true })
    }

    // write any changes to the feed
    if (changeSets.length) feed.append(JSON.stringify(changeSets))

    return newState
  }
}
