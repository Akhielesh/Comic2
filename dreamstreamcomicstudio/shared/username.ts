export const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;
export const USERNAME_HINT = 'Use 3–20 letters, numbers or underscores. Capitalization does not change the username.';
export interface UsernameAvailability { available: boolean; suggestions: string[] }
