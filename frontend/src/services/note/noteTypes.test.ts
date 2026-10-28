import { describe, expect, it } from 'vitest';
import {
  EDITABLE_NOTE_TYPES,
  NOTE_TYPE_LABEL,
  NOTE_TYPES,
  isDocumentType,
} from './noteTypes';

describe('noteTypes', () => {
  it('includes document in all note types', () => {
    expect(NOTE_TYPES).toContain('document');
    expect(NOTE_TYPES).toHaveLength(5);
  });

  it('does not allow creating document notes directly', () => {
    expect(EDITABLE_NOTE_TYPES).not.toContain('document');
    expect(EDITABLE_NOTE_TYPES).toHaveLength(4);
  });

  it('has a label for every type', () => {
    for (const type of NOTE_TYPES) {
      expect(NOTE_TYPE_LABEL[type]).toBeTruthy();
    }
  });

  it('detects document type', () => {
    expect(isDocumentType('document')).toBe(true);
    expect(isDocumentType('markdown')).toBe(false);
    expect(isDocumentType(null)).toBe(false);
  });
});
