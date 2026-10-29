// Share links are the only way a note becomes visible to someone other than its owner.
// A deleted note is never readable, not even by its owner.
export function canRead(note, userId, shareToken) {
  if (note.deletedAt) return false;
  if (note.ownerId === userId) return true;
  return note.shareToken !== null && note.shareToken === shareToken;
}
