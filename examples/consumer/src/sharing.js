// Share links are the only way a note becomes visible to someone other than its owner.
// A deleted note is never readable, not even by its owner.
// A missing user or token never matches, even when the note's own field is missing too.
export function canRead(note, userId, shareToken) {
  if (note.deletedAt) return false;
  if (userId && note.ownerId === userId) return true;
  return Boolean(shareToken) && note.shareToken === shareToken;
}
