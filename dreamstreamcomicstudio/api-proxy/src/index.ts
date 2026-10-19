/**
 * dreamstream-api Worker entry. The request handling lives in proxy.ts (kept free
 * of Workers-only imports so it unit-tests under plain Node); the backend
 * Container class must be exported from the entry module for its Durable Object binding.
 */
export { Backend } from './backend';
export { default } from './proxy';
