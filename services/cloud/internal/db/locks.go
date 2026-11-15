package db

// Advisory locks that are named by a string (the key is hashed with hashtextextended): the lock on
// the publication of a blob, on the upload quota checks of an owner and on the export requests of a
// user. Until 1.5 the names started with the product name of 1.x ("<old product name>.blob:<hash>", ...);
// the rebrand renamed them ("clarae.blob:<hash>", ...).
//
// In the 1.5 and 1.6 lines a pod took the OLD name first and the NEW one second (always in this order,
// so it could not deadlock), because during a rolling upgrade pods of 1.4 and of 1.5 run together on
// the same database: a pod of 1.4 takes the old name only, so a pod that took the new name only would
// not have excluded it, and two uploads of the same blob, or two quota checks of the same owner, could
// have run at once.
//
// Since 1.7 only the new name is taken. The consequence is an operational constraint: a pod of 1.4 or
// of any earlier release must never run together with a pod of 1.7 or later on the same database,
// because the two would no longer exclude each other. An installation on 1.4 or earlier upgrades to
// 1.5 or 1.6 first, and only then to 1.7. Nothing else changed: the keys are passed to the generated
// Lock* queries as before.

// lockPrefix starts the names of the string-keyed advisory locks.
const lockPrefix = "clarae."

// AdvisoryLockKeys returns the keys of the named advisory lock "<kind>:<id>" to take with the
// transaction-level lock query: exactly one, "clarae.<kind>:<id>". It is a slice so that the callers
// iterate over the keys of a lock, as they did while the name of 1.x was taken too.
func AdvisoryLockKeys(kind, id string) []string {
	return []string{lockPrefix + kind + ":" + id}
}
