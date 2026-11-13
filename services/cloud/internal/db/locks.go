package db

// Advisory locks that are named by a string (the key is hashed with hashtextextended): the lock on
// the publication of a blob, on the upload quota checks of an owner and on the export requests of a
// user. Until 2.0 the names started with the product name of 1.x ("memobrain.blob:<hash>", ...); the
// rebrand renamed them ("clarae.blob:<hash>", ...).
//
// During a rolling upgrade pods of 1.4 and of 2.0 run together on the same database. A pod of 1.4
// takes the old name only, so a pod of 2.0 that took the new name only would not exclude it: two
// uploads of the same blob, or two quota checks of the same owner, could run at once. For the whole
// 2.0 line a pod therefore takes the OLD lock first and the NEW one second, always in this order (a
// fixed order cannot deadlock: whoever holds the old lock is the only one that proceeds to the new
// one), and both are released when the transaction ends.
//
// Dropped in 2.1, when no pod of 1.x can be running any more: AdvisoryLockKeys then returns the new
// name alone. Nothing else changes (the keys are passed to the generated Lock* queries).

// legacyLockPrefix and lockPrefix start the names of the string-keyed advisory locks.
const (
	legacyLockPrefix = "memobrain."
	lockPrefix       = "clarae."
)

// AdvisoryLockKeys returns the keys of the named advisory lock "<kind>:<id>" in the order they must
// be taken: the name of 1.x first, then the current one. Take them one after the other with the same
// transaction-level lock query.
func AdvisoryLockKeys(kind, id string) []string {
	suffix := kind + ":" + id
	return []string{legacyLockPrefix + suffix, lockPrefix + suffix}
}
