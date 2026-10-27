{{- define "nodus.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "nodus.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nodus.labels" -}}
app.kubernetes.io/name: {{ include "nodus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Labels selecting the pods of one role. Usage: include "nodus.selector" (dict "root" $ "role" "api") */}}
{{- define "nodus.selector" -}}
app.kubernetes.io/name: {{ include "nodus.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{- define "nodus.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "nodus.secretName" -}}
{{- if .Values.secret.existingSecret -}}{{ .Values.secret.existingSecret }}{{- else -}}{{ include "nodus.fullname" . }}{{- end -}}
{{- end -}}

{{- define "nodus.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ default (include "nodus.fullname" .) .Values.serviceAccount.name }}{{- else -}}{{ default "default" .Values.serviceAccount.name }}{{- end -}}
{{- end -}}

{{/* Scheduling constraints of a role. Usage: include "nodus.scheduling" (dict "root" $ "role" "api" "spec" $spec) */}}
{{- define "nodus.scheduling" -}}
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
          matchLabels: {{- include "nodus.selector" (dict "root" .root "role" .role) | nindent 12 }}
    {{- else }}
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels: {{- include "nodus.selector" (dict "root" .root "role" .role) | nindent 14 }}
    {{- end }}
{{- end }}
{{- if $spec.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ $spec.topologySpread.maxSkew }}
    topologyKey: {{ $spec.topologySpread.topologyKey }}
    whenUnsatisfiable: {{ $spec.topologySpread.whenUnsatisfiable }}
    labelSelector:
      matchLabels: {{- include "nodus.selector" (dict "root" .root "role" .role) | nindent 8 }}
{{- end }}
{{- end -}}
