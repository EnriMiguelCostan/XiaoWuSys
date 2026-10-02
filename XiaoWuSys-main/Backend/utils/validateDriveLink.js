// ==========================================
// GOOGLE DRIVE LINK VALIDATION (Audit fix H6)
// Blocks stored XSS (javascript:, data:, etc.) and non-Drive URLs before they reach the DB.
// ==========================================

const ALLOWED_HOSTS = new Set(['drive.google.com', 'docs.google.com']);
const MAX_LINK_LENGTH = 2048;

// Returns { url } with the normalized link, or { error } describing why it was rejected
const validateDriveLink = (input) => {
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'Google Drive link is required.' };
  }

  const raw = input.trim();
  if (raw.length > MAX_LINK_LENGTH) {
    return { error: `Google Drive link must be at most ${MAX_LINK_LENGTH} characters.` };
  }
  // Reject control characters/whitespace inside the link (URL parsing would silently strip some)
  if (/[\u0000-\u001F\u007F\s]/.test(raw)) {
    return { error: 'Google Drive link must not contain spaces or control characters.' };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'Google Drive link must be a valid URL.' };
  }

  if (url.protocol !== 'https:') {
    return { error: 'Google Drive link must use https://.' };
  }
  if (url.username || url.password) {
    return { error: 'Google Drive link must not contain credentials.' };
  }
  if (url.port !== '') {
    return { error: 'Google Drive link must not specify a port.' };
  }
  // URL() lowercases the hostname; exact match blocks look-alikes such as drive.google.com.evil.com
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return { error: 'Link must point to drive.google.com or docs.google.com.' };
  }

  return { url: url.href };
};

module.exports = { validateDriveLink, ALLOWED_HOSTS };
