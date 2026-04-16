/**
 * Image generator module.
 * Attempts to use OpenAI DALL-E if an API key is configured.
 * Falls back to curated placeholder images with silly prompts.
 */

let openai = null;

try {
  const OpenAI = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch {
  // OpenAI not available, will use fallback
}

// Silly, thought-provoking image prompts for DALL-E
const IMAGE_PROMPTS = [
  'A cat wearing a tiny business suit presenting a PowerPoint to a room full of dogs, cartoon style, family friendly',
  'A penguin riding a unicycle through a grocery store, whimsical illustration, family friendly',
  'A squirrel lifting weights at a tiny gym made of acorns, cartoon style, family friendly',
  'A group of frogs having a formal tea party on a lily pad, whimsical illustration, family friendly',
  'A goldfish driving a submarine through a bathtub, cartoon style, family friendly',
  'A hamster piloting a paper airplane over a desk, whimsical illustration, family friendly',
  'A raccoon trying to use a vending machine in a park, cartoon style, family friendly',
  'An owl teaching math class to a group of confused mice, whimsical illustration, family friendly',
  'A duck wearing sunglasses skateboarding down a sidewalk, cartoon style, family friendly',
  'A turtle running a marathon while snails cheer from the sidelines, whimsical illustration, family friendly',
  'A rabbit operating a food truck selling carrots to other animals, cartoon style, family friendly',
  'A bear trying to fit into a tiny car at a drive-through, whimsical illustration, family friendly',
  'A giraffe trying to limbo at a beach party, cartoon style, family friendly',
  'A group of chickens playing poker with corn kernels as chips, whimsical illustration, family friendly',
  'An elephant trying to hide behind a small plant in an office, cartoon style, family friendly',
  'A mouse directing traffic in a city of cheese buildings, whimsical illustration, family friendly',
  'A sloth winning a speed-eating contest against cheetahs, cartoon style, family friendly',
  'A parrot doing stand-up comedy for an audience of house cats, whimsical illustration, family friendly',
  'A crab giving a haircut to a starfish at an underwater salon, cartoon style, family friendly',
  'A goat reviewing food at a fancy five-star restaurant, whimsical illustration, family friendly',
  'A dog dressed as a detective investigating who ate the homework, cartoon style, family friendly',
  'A pig painting a masterpiece at an easel in a barn, whimsical illustration, family friendly',
  'A chameleon having an identity crisis at a color palette store, cartoon style, family friendly',
  'A walrus trying to do yoga in a crowded fitness class, whimsical illustration, family friendly',
  'A flamingo working as an air traffic controller at a bird airport, cartoon style, family friendly',
  'A hedgehog inflating a balloon nervously at a birthday party, whimsical illustration, family friendly',
  'An octopus multitasking eight different jobs at once, cartoon style, family friendly',
  'A moose stuck in a revolving door at a fancy hotel, whimsical illustration, family friendly',
  'A sheep counting humans to fall asleep, cartoon style, family friendly',
  'A platypus at a job interview explaining what it is, whimsical illustration, family friendly',
];

// Fallback: curated placeholder images using picsum with seed for consistency
// Each comes with a description that matches the silly prompt theme
const FALLBACK_IMAGES = IMAGE_PROMPTS.map((prompt, i) => ({
  url: `https://picsum.photos/seed/caption${i}/600/400`,
  prompt: prompt.replace(/, (cartoon style|whimsical illustration), family friendly/g, ''),
}));

let usedIndices = new Set();

/**
 * Get a random image for the game round.
 * @returns {Promise<{url: string, prompt: string}>}
 */
async function getRandomImage() {
  // Reset used indices if we've exhausted the pool
  if (usedIndices.size >= IMAGE_PROMPTS.length) {
    usedIndices.clear();
  }

  // Pick a random unused index
  let index;
  do {
    index = Math.floor(Math.random() * IMAGE_PROMPTS.length);
  } while (usedIndices.has(index));
  usedIndices.add(index);

  // Try DALL-E first
  if (openai) {
    try {
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: IMAGE_PROMPTS[index],
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      });
      return {
        url: response.data[0].url,
        prompt: IMAGE_PROMPTS[index].replace(/, (cartoon style|whimsical illustration), family friendly/g, ''),
      };
    } catch (err) {
      console.error('DALL-E generation failed, using fallback:', err.message);
    }
  }

  // Fallback to placeholder
  return FALLBACK_IMAGES[index];
}

/**
 * Reset used image tracking (for new game sessions).
 */
function resetImagePool() {
  usedIndices.clear();
}

module.exports = { getRandomImage, resetImagePool };
