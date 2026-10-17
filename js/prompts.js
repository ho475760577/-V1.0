/** Fixed narrative length and request budget for StoryRealm v3. */

export const MIN_BODY_CHARS = 1000;
export const MAX_BODY_CHARS = 2000;
export const TARGET_BODY_CHARS = 1400;

export function getBodyTarget() {
  return TARGET_BODY_CHARS;
}

export function getBodyLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/** The budget is internal; users no longer select a length preset. */
export function generationOptions() {
  return { max_tokens: 4600 };
}
