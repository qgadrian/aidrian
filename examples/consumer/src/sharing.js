// Share links are the only way a note becomes visible to someone other than its owner.
export function canRead(note, userId, shareToken) {
  if (note.ownerId === userId) return true;
  return note.shareToken !== null && note.shareToken === shareToken && !note.deletedAt;
}
