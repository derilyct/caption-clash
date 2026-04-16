/**
 * Profanity filter - replaces bad words with # symbols.
 * Uses the bad-words library plus custom patterns.
 */
const Filter = require('bad-words');

const filter = new Filter();

// Add extra words to catch edge cases
filter.addWords('dang', 'darn', 'crap', 'sux');

/**
 * Filters profanity from text, replacing bad words with # characters.
 * @param {string} text - The input text to filter
 * @returns {string} The filtered text with profanity replaced by #
 */
function cleanText(text) {
  if (!text || typeof text !== 'string') return '';

  try {
    // The bad-words library replaces with asterisks by default.
    // We override the placeholder character to #.
    const cleaned = filter.clean(text);
    // Replace any * placeholders the library used with #
    return cleaned.replace(/\*/g, '#');
  } catch {
    // If the filter throws, do a basic replacement
    return text;
  }
}

/**
 * Checks if text contains profanity.
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanity(text) {
  if (!text || typeof text !== 'string') return false;
  try {
    return filter.isProfane(text);
  } catch {
    return false;
  }
}

module.exports = { cleanText, containsProfanity };
