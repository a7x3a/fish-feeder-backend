/**
 * Firebase helper utilities for optimized operations
 */

/**
 * Optimized Firebase read with timeout and retry
 */
export async function readWithTimeout(ref, timeoutMs = 8000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const snapshot = await Promise.race([
          ref.once('value'),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('firebase_timeout')), timeoutMs)
          )
        ]);
        clearTimeout(timeoutId);
        return snapshot;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.message === 'firebase_timeout' && attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Optimized Firebase write with timeout
 */
export async function writeWithTimeout(ref, value, timeoutMs = 8000) {
  return Promise.race([
    ref.set(value),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('firebase_timeout')), timeoutMs)
    )
  ]);
}

/**
 * Batch write multiple Firebase operations
 */
export async function batchWrite(operations, timeoutMs = 10000) {
  return Promise.race([
    Promise.all(operations.map(op => op.ref.set(op.value))),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('firebase_timeout')), timeoutMs)
    )
  ]);
}

