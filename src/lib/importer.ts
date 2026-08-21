import type { Passenger } from './types';
import { hubDisplayName } from './types';
import { sanitizeTransportValue } from './transportSanitization';

export interface RawSheetRow {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Converts strings to Title Case (e.g. "john doe" -> "John Doe", "SIPHO DLAMINI" -> "Sipho Dlamini")
 */
export function toTitleCase(str: string): string {
  const cleaned = sanitizeTransportValue(str).trim();
  if (!cleaned) return '';
  
  // If it's already mixed case with intentional formatting, or standard title-case, handle each word
  return cleaned
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((word) => {
      if (!word || /^\s+$/.test(word) || word === '-') return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/**
 * Sanitizes phone numbers while strictly preserving leading '+' or '0'
 */
export function sanitizePhone(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;

  const hasPlus = str.startsWith('+');
  const hasLeadingZero = !hasPlus && str.startsWith('0');

  // Strip all non-digit characters except leading plus
  const digitsOnly = str.replace(/\D/g, '');
  if (!digitsOnly) return undefined;

  if (hasPlus) {
    return `+${digitsOnly}`;
  }
  if (hasLeadingZero && !digitsOnly.startsWith('0')) {
    return `0${digitsOnly}`;
  }
  return digitsOnly;
}

/**
 * Standardizes timestamp strings into ISO 8601 strings
 */
export function parseTimestampToISO(raw: unknown): string | undefined {
  if (!raw) return undefined;
  try {
    const d = new Date(String(raw).trim());
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {
    // Fallback: return trimmed string
  }
  return String(raw).trim() || undefined;
}

/**
 * Normalizes service responses from Google Sheets / MS Forms into standard ServiceType codes
 * (e.g. AM_Normal, PM_Normal, AM_Serving, PM_Serving, AM_Mega, PM_Mega)
 */
export function normalizeService(raw: string, defaultService?: string): string {
  const s = raw.toLowerCase().trim();
  if (!s && defaultService) return defaultService;

  const isAM = s.includes('am') || s.includes('morning') || s.includes('08:') || s.includes('09:') || s.includes('10:');
  const isPM = s.includes('pm') || s.includes('evening') || s.includes('afternoon') || s.includes('17:') || s.includes('18:');

  const isServing = s.includes('serving') || s.includes('usher') || s.includes('choir') || s.includes('band') || s.includes('volunteer');
  const isMega = s.includes('mega');

  const period = isAM ? 'AM' : isPM ? 'PM' : (defaultService?.startsWith('AM') ? 'AM' : 'PM');
  const mode = isMega ? 'Mega' : isServing ? 'Serving' : 'Normal';

  return `${period}_${mode}`;
}

/**
 * Ingests and parses sign-up responses from the 2026 Google Sheet / Microsoft Form format.
 * Matches incoming sheet columns dynamically using flexible string matching and regex.
 */
export function parseGoogleSheetSignups(
  rows: RawSheetRow[],
  defaultService: string = 'PM_Normal'
): Passenger[] {
  return rows
    .map((row, index) => {
      // Find column values using flexible case-insensitive header matching
      const findValue = (keywords: string[]): string => {
        const rowKeys = Object.keys(row);
        for (const kw of keywords) {
          const lowerKw = kw.toLowerCase().trim();
          // 1. Exact match
          const exactKey = rowKeys.find((k) => k.toLowerCase().trim() === lowerKw);
          if (exactKey && row[exactKey] !== undefined && row[exactKey] !== null) {
            return String(row[exactKey]).trim();
          }
          // 2. Contains match
          const matchedKey = rowKeys.find((k) => k.toLowerCase().includes(lowerKw));
          if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== null) {
            return String(row[matchedKey]).trim();
          }
        }
        return '';
      };

      // Full Name extraction with first/last name fallback
      let rawFullName = findValue([
        'Full Name',
        'First and Last Name',
        'Name',
        'Passenger Name',
        'Name2',
      ]);

      if (!rawFullName) {
        const firstName = findValue(['First Name', 'Firstname', 'Name1', 'Name 1', 'Name 2']);
        const surname = findValue(['Last Name', 'Surname', 'Lastname', 'Family Name']);
        if (firstName || surname) {
          rawFullName = [firstName, surname].filter(Boolean).join(' ');
        }
      }

      const fullName = toTitleCase(rawFullName);

      // Stop extraction
      const rawStop = sanitizeTransportValue(
        findValue([
          'Pickup Stop',
          'Stop',
          'Boarding Location',
          'Sub-Stop',
          'Sub Stop',
          'Where will you join',
          'Area Stops2',
          'Area Stops',
          'Pickup Location',
          'Station',
        ])
      );

      // Structure extraction
      const rawStructure = findValue([
        'Structure',
        'Zone / Structure',
        'Zone',
        'SZ1 Structures',
        'SZ1',
        'SZ2 Structures',
        'SZ2',
        'YZ Structures',
        'YZ',
        'Assembly Structure',
        'Home Structure',
        'PCF Structure',
      ]);
      const structure = sanitizeTransportValue(rawStructure).toUpperCase();

      // Contact info
      const rawPhone = findValue(['Phone Number', 'WhatsApp Number', 'Contact Number', 'Phone', 'WhatsApp', 'Contact', 'Cell', 'Mobile']);
      const phone = sanitizePhone(rawPhone);

      const rawEmail = findValue(['Email Address', 'Email', 'User Email', 'Mail']);
      const userEmail = rawEmail ? sanitizeTransportValue(rawEmail).toLowerCase() : undefined;

      // Timestamp
      const rawTimestamp = findValue(['Completion time', 'Submission Time', 'Timestamp', 'Created At', 'Date Submitted']);
      const timestamp = parseTimestampToISO(rawTimestamp);

      // Service
      const rawService = findValue([
        'Which service are you attending?',
        'Service',
        'Attending',
        'AM Service Type',
        'PM Service Type',
        'Service Type',
      ]);
      const service = normalizeService(rawService, defaultService);

      // Hub derivation
      const explicitHub = findValue(['Hub', 'Master Hub', 'Taxi Hub']);
      const effectiveStop = rawStop || 'Unspecified';
      const hub = explicitHub
        ? sanitizeTransportValue(explicitHub)
        : hubDisplayName('Taxi', effectiveStop);

      const id = `p-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;

      return {
        id,
        fullName: fullName || 'Unnamed Passenger',
        stop: effectiveStop,
        structure: structure || '',
        phone,
        userEmail,
        timestamp,
        hub,
        service,
        assignedTo: null,
        present: false,
        cancellationFeeOwed: false,
      };
    })
    .filter((p) => p.fullName !== 'Unnamed Passenger' || p.stop !== 'Unspecified');
}
