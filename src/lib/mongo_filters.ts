// Null-filter helpers for the MongoDB datasource.
//
// WHY THIS EXISTS
//
// On MongoDB, Prisma compiles `where: { field: null }` down to a query that
// only matches documents where the key EXISTS and holds null. It does *not*
// match documents that have no such key at all.
//
// That distinction bites because Prisma omits unset optional fields on
// insert: a freshly created row is written with no key for its untouched
// optional columns. So `{ field: null }` — the spelling that is correct on
// every SQL datasource — silently matches zero rows on Mongo.
//
// This is not theoretical. It is what made the community feed return an
// empty list while 14 live posts sat in the database, and what kept the
// unread-notification badge pinned at zero with 7 unread rows present.
//
// Use [isUnset] for any "this optional field was never set" filter. Each
// call returns a fresh object so callers can spread it into a `where`
// without sharing (or mutating) a module-level literal.
export function isUnset(field: string) {
  return {
    OR: [{ [field]: null }, { [field]: { isSet: false } }],
  };
}

/** "Row is not soft-deleted" — the `deletedAt` flavour of [isUnset]. */
export function notDeleted() {
  return isUnset("deletedAt");
}

/** "Notification has not been read yet" — the `readAt` flavour of [isUnset]. */
export function isUnread() {
  return isUnset("readAt");
}
