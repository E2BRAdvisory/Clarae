package links

// PlanRenameFull exposes the whole-vault rename planner to the external tests.
var PlanRenameFull = planRenameFull

// SetBeforeMoveHook runs fn between the rewrites and the move of ApplyRename.
func SetBeforeMoveHook(fn func()) { testHookBeforeMove = fn }
