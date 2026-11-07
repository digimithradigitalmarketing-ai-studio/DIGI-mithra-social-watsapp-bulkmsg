import type { Deps } from '../deps';
import { emitEvent, type AutomationEvent } from './engine';

/** Fire automation events after the user's transaction has committed. Never breaks the user's action. */
export async function emitSafe(deps: Deps, events: AutomationEvent[]) {
  for (const ev of events) {
    try {
      await emitEvent(deps.db, ev);
    } catch (err) {
      deps.logger.error({ err, event: ev.type }, 'automation event failed');
    }
  }
}
