package app

// Services returns the API structs the frontend calls, in the order they are bound. The desktop
// hands them to Wails (main.go) and the browser build to the RPC dispatcher
// (cmd/memobrain-core): one list, so the two can never expose different APIs.
func (a *App) Services() []any {
	return []any{
		NewVaultAPI(a),
		NewSearchAPI(a),
		NewExportAPI(a),
		NewSettingsAPI(a),
		NewAuthAPI(a),
		NewLinksAPI(a),
		NewTagsAPI(a),
		NewPropertiesAPI(a),
		NewSyncAPI(a),
		NewHistoryAPI(a),
		NewVaultCryptoAPI(a),
		NewDrawingAPI(a),
		NewSharingAPI(a),
		NewConfigAPI(a),
		NewGraphAPI(a),
		NewBasesAPI(a),
		NewTemplatesAPI(a),
		NewComposerAPI(a),
		NewImporterAPI(a),
		NewUpdaterAPI(a),
		NewAIAPI(a),
	}
}
