/// <reference lib="webworker" />
import { answerJob, type WorkerRequest } from './fractionRunner'

/** The Web Worker that runs the fraction simulations off the page's thread (AD-103). */
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null; postMessage: (m: unknown) => void }
scope.onmessage = (e) => scope.postMessage(answerJob(e.data))
