{{- define "clarae.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "clarae.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "clarae.labels" -}}
app.kubernetes.io/name: {{ include "clarae.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Labels selecting the pods of one role. Usage: include "clarae.selector" (dict "root" $ "role" "api") */}}
{{- define "clarae.selector" -}}
app.kubernetes.io/name: {{ include "clarae.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{- define "clarae.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "clarae.secretName" -}}
{{- if .Values.secret.existingSecret -}}{{ .Values.secret.existingSecret }}{{- else -}}{{ include "clarae.fullname" . }}{{- end -}}
{{- end -}}

{{- define "clarae.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ default (include "clarae.fullname" .) .Values.serviceAccount.name }}{{- else -}}{{ default "default" .Values.serviceAccount.name }}{{- end -}}
{{- end -}}

{{/* Scheduling constraints of a role. Usage: include "clarae.scheduling" (dict "root" $ "role" "api" "spec" $spec) */}}
{{- define "clarae.scheduling" -}}
{{- $spec := .spec -}}
{{- with $spec.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $spec.tolerations }}
tolerations: {{- toYaml . | nindent 2 }}
{{- end }}
{{- if $spec.affinity }}
affinity: {{- toYaml $spec.affinity | nindent 2 }}
{{- else if ne $spec.antiAffinity "none" }}
affinity:
  podAntiAffinity:
    {{- if eq $spec.antiAffinity "hard" }}
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels: {{- include "clarae.selector" (dict "root" .root "role" .role) | nindent 12 }}
    {{- else }}
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels: {{- include "clarae.selector" (dict "root" .root "role" .role) | nindent 14 }}
    {{- end }}
{{- end }}
{{- if $spec.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ $spec.topologySpread.maxSkew }}
    topologyKey: {{ $spec.topologySpread.topologyKey }}
    whenUnsatisfiable: {{ $spec.topologySpread.whenUnsatisfiable }}
    labelSelector:
      matchLabels: {{- include "clarae.selector" (dict "root" .root "role" .role) | nindent 8 }}
{{- end }}
{{- end -}}

{{/* "true" when the cluster supports the preStop sleep action (on by default from Kubernetes 1.30), else empty. */}}
{{- define "clarae.preStopSleepSupported" -}}
{{- if semverCompare ">=1.30.0-0" .Capabilities.KubeVersion.Version -}}true{{- end -}}
{{- end -}}

{{/*
Fails the render when the chart would create the Secret (no existingSecret, no externalSecret) with an empty
required value, or with a placeholder of the templates (change-me, change-me-too, changeme) unless
config.CLARAE_ALLOW_PLACEHOLDER_SECRETS is "1"/"true" (the service applies the same rule at start).
*/}}
{{- define "clarae.checkSecretValues" -}}
{{- $values := default (dict) .Values.secret.values -}}
{{- $allow := has (lower (toString (default "" .Values.config.CLARAE_ALLOW_PLACEHOLDER_SECRETS))) (list "1" "true") -}}
{{- $placeholders := list "change-me" "change-me-too" "changeme" -}}
{{- range $key := list "DATABASE_URL" "S3_ACCESS_KEY" "S3_SECRET_KEY" "KC_ADMIN_CLIENT_SECRET" -}}
{{- $v := trim (toString (default "" (get $values $key))) -}}
{{- if not $v -}}
{{- fail (printf "secret.values.%s is empty: set it, or point secret.existingSecret / externalSecret at a managed Secret (recommended)" $key) -}}
{{- end -}}
{{- $bad := has (lower $v) $placeholders -}}
{{- if eq $key "DATABASE_URL" -}}
{{- $bad = regexMatch "(?i)(:(change-me|change-me-too|changeme)@|password=['\"]?(change-me|change-me-too|changeme)(['\"&[:space:]]|$))" $v -}}
{{- end -}}
{{- if and $bad (not $allow) -}}
{{- fail (printf "secret.values.%s holds a placeholder (change-me...): set a real secret" $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
