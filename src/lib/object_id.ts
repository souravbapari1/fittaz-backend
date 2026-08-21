// MongoDB ObjectIds are 24 hex characters. Prisma throws a
// `PrismaClientKnownRequestError` ("Malformed ObjectID") when a `where`
// clause carries anything else, which Express surfaces as a blanket 500 —
// so a stale client id or a hand-typed deep link reads to the user as
// "the server is broken" rather than "that thing doesn't exist".
//
// Guard route params with this and return a clean 404 instead.
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_RE.test(value);
}
