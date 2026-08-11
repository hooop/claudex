/**
 * Typed EventEmitter wrapper for Node.js EventEmitter.
 *
 * Provides type-safe event emission and subscription.
 */

import { EventEmitter } from "node:events";

/**
 * A typed event map where keys are event names and values are tuples of arguments.
 */
export type EventMap<Events> = { [K in keyof Events]: unknown[] };

/**
 * Type-safe EventEmitter that enforces event types.
 */
export class TypedEmitter<Events extends EventMap<Events>> {
  private emitter = new EventEmitter();

  /**
   * Subscribe to an event with a typed handler.
   */
  on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Subscribe to an event once.
   */
  once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Unsubscribe a specific handler.
   */
  off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /**
   * Emit an event with typed arguments.
   */
  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  /**
   * Remove all listeners for a specific event or all events.
   */
  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  /**
   * Get the number of listeners for an event.
   */
  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}
