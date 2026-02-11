import { GoogleGenAI } from '@google/genai';
import { GEMINI_BASE_URL } from '../config.js';

export const createClient = (apiKey: string) => {
  if (!apiKey) {
    throw new Error('Gemini API key not found.');
  }
  // @ts-ignore - The SDK might support baseUrl in options
  return new GoogleGenAI({ apiKey, baseUrl: GEMINI_BASE_URL });
};
