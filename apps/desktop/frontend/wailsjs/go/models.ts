export namespace app {
	
	export class AppSettings {
	    language: string;
	    theme: string;
	    trashMode: string;
	
	    static createFrom(source: any = {}) {
	        return new AppSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.language = source["language"];
	        this.theme = source["theme"];
	        this.trashMode = source["trashMode"];
	    }
	}
	export class FormulaInfo {
	    name: string;
	    expr: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new FormulaInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.expr = source["expr"];
	        this.error = source["error"];
	    }
	}
	export class ViewInfo {
	    name: string;
	    type: string;
	    supported: boolean;
	    notice: string;
	    order: string[];
	    sort: bases.SortSpec[];
	    groupBy?: bases.SortSpec;
	    limit: number;
	    filters: bases.Chip[];
	    baseFilters: bases.Chip[];
	
	    static createFrom(source: any = {}) {
	        return new ViewInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.supported = source["supported"];
	        this.notice = source["notice"];
	        this.order = source["order"];
	        this.sort = this.convertValues(source["sort"], bases.SortSpec);
	        this.groupBy = this.convertValues(source["groupBy"], bases.SortSpec);
	        this.limit = source["limit"];
	        this.filters = this.convertValues(source["filters"], bases.Chip);
	        this.baseFilters = this.convertValues(source["baseFilters"], bases.Chip);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class BaseInfo {
	    path: string;
	    hash: string;
	    parseError: string;
	    views: ViewInfo[];
	    formulas: FormulaInfo[];
	    notices: string[];
	
	    static createFrom(source: any = {}) {
	        return new BaseInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.hash = source["hash"];
	        this.parseError = source["parseError"];
	        this.views = this.convertValues(source["views"], ViewInfo);
	        this.formulas = this.convertValues(source["formulas"], FormulaInfo);
	        this.notices = source["notices"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class BinaryContent {
	    path: string;
	    mime: string;
	    data: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new BinaryContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.mime = source["mime"];
	        this.data = source["data"];
	        this.size = source["size"];
	    }
	}
	export class CloudVault {
	    id: string;
	    name: string;
	    kind: string;
	    totalBytes: number;
	    fileCount: number;
	    // Go type: time
	    createdAt: any;
	
	    static createFrom(source: any = {}) {
	        return new CloudVault(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.totalBytes = source["totalBytes"];
	        this.fileCount = source["fileCount"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConfigState {
	    version: number;
	    config: Record<string, any>;
	    lockedKeys: string[];
	    managed: boolean;
	    fetchedAt: string;
	    features: Record<string, boolean>;
	
	    static createFrom(source: any = {}) {
	        return new ConfigState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.config = source["config"];
	        this.lockedKeys = source["lockedKeys"];
	        this.managed = source["managed"];
	        this.fetchedAt = source["fetchedAt"];
	        this.features = source["features"];
	    }
	}
	export class ConflictTexts {
	    current: string;
	    ours: string;
	
	    static createFrom(source: any = {}) {
	        return new ConflictTexts(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.ours = source["ours"];
	    }
	}
	export class DailyOptions {
	    date: string;
	    folder: string;
	    format: string;
	    template: string;
	    lang: string;
	
	    static createFrom(source: any = {}) {
	        return new DailyOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.date = source["date"];
	        this.folder = source["folder"];
	        this.format = source["format"];
	        this.template = source["template"];
	        this.lang = source["lang"];
	    }
	}
	export class DeviceInfo {
	    id: string;
	    name: string;
	    platform: string;
	    appVersion: string;
	    // Go type: time
	    lastSeenAt?: any;
	    current: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DeviceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.platform = source["platform"];
	        this.appVersion = source["appVersion"];
	        this.lastSeenAt = this.convertValues(source["lastSeenAt"], null);
	        this.current = source["current"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DirectoryEntry {
	    type: string;
	    id: string;
	    name: string;
	    label: string;
	
	    static createFrom(source: any = {}) {
	        return new DirectoryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.id = source["id"];
	        this.name = source["name"];
	        this.label = source["label"];
	    }
	}
	export class ExportResult {
	    path: string;
	    files: number;
	    bytes: number;
	    cancelled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ExportResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.files = source["files"];
	        this.bytes = source["bytes"];
	        this.cancelled = source["cancelled"];
	    }
	}
	
	export class GrantInfo {
	    principalType: string;
	    principalId: string;
	    principalName: string;
	    permission: string;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new GrantInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.principalType = source["principalType"];
	        this.principalId = source["principalId"];
	        this.principalName = source["principalName"];
	        this.permission = source["permission"];
	        this.status = source["status"];
	    }
	}
	export class GrantInput {
	    principalType: string;
	    principalId: string;
	    permission: string;
	
	    static createFrom(source: any = {}) {
	        return new GrantInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.principalType = source["principalType"];
	        this.principalId = source["principalId"];
	        this.permission = source["permission"];
	    }
	}
	export class NoteContent {
	    path: string;
	    content: string;
	    hash: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new NoteContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.hash = source["hash"];
	        this.size = source["size"];
	    }
	}
	export class NoteResult {
	    path: string;
	    created: boolean;
	
	    static createFrom(source: any = {}) {
	        return new NoteResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.created = source["created"];
	    }
	}
	export class PropertyKey {
	    key: string;
	    kind: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new PropertyKey(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.kind = source["kind"];
	        this.count = source["count"];
	    }
	}
	export class ShareInfo {
	    id: string;
	    vaultId: string;
	    vaultName: string;
	    resourceType: string;
	    pathPrefix: string;
	    displayName: string;
	    ownerName: string;
	    createdAt: string;
	    expiresAt: string;
	    myPermission: string;
	    myStatus: string;
	    grants: GrantInfo[];
	
	    static createFrom(source: any = {}) {
	        return new ShareInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.vaultId = source["vaultId"];
	        this.vaultName = source["vaultName"];
	        this.resourceType = source["resourceType"];
	        this.pathPrefix = source["pathPrefix"];
	        this.displayName = source["displayName"];
	        this.ownerName = source["ownerName"];
	        this.createdAt = source["createdAt"];
	        this.expiresAt = source["expiresAt"];
	        this.myPermission = source["myPermission"];
	        this.myStatus = source["myStatus"];
	        this.grants = this.convertValues(source["grants"], GrantInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TagCount {
	    name: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new TagCount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.count = source["count"];
	    }
	}
	export class TemplateInfo {
	    name: string;
	    path: string;
	    source: string;
	    ref: string;
	    library: string;
	
	    static createFrom(source: any = {}) {
	        return new TemplateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.source = source["source"];
	        this.ref = source["ref"];
	        this.library = source["library"];
	    }
	}
	export class UniqueOptions {
	    folder: string;
	    format: string;
	    template: string;
	    lang: string;
	
	    static createFrom(source: any = {}) {
	        return new UniqueOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folder = source["folder"];
	        this.format = source["format"];
	        this.template = source["template"];
	        this.lang = source["lang"];
	    }
	}
	export class UsageInfo {
	    usedBytes: number;
	    quotaBytes: number;
	    level: string;
	
	    static createFrom(source: any = {}) {
	        return new UsageInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.usedBytes = source["usedBytes"];
	        this.quotaBytes = source["quotaBytes"];
	        this.level = source["level"];
	    }
	}
	export class VaultInfo {
	    id: string;
	    name: string;
	    path: string;
	    // Go type: time
	    lastOpenedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new VaultInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.lastOpenedAt = this.convertValues(source["lastOpenedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class WriteResult {
	    path: string;
	    hash: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new WriteResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.hash = source["hash"];
	        this.size = source["size"];
	    }
	}

}

export namespace auth {
	
	export class Profile {
	    userId: string;
	    username: string;
	    email: string;
	    displayName: string;
	    role: string;
	
	    static createFrom(source: any = {}) {
	        return new Profile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.userId = source["userId"];
	        this.username = source["username"];
	        this.email = source["email"];
	        this.displayName = source["displayName"];
	        this.role = source["role"];
	    }
	}
	export class State {
	    status: string;
	    serverUrl: string;
	    profile: Profile;
	    deviceId: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new State(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.status = source["status"];
	        this.serverUrl = source["serverUrl"];
	        this.profile = this.convertValues(source["profile"], Profile);
	        this.deviceId = source["deviceId"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace bases {
	
	export class Cell {
	    k: string;
	    v?: any;
	    e?: string;
	
	    static createFrom(source: any = {}) {
	        return new Cell(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.k = source["k"];
	        this.v = source["v"];
	        this.e = source["e"];
	    }
	}
	export class Chip {
	    text: string;
	    simple: boolean;
	    index: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new Chip(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.text = source["text"];
	        this.simple = source["simple"];
	        this.index = source["index"];
	        this.error = source["error"];
	    }
	}
	export class Column {
	    id: string;
	    key: string;
	    name: string;
	    kind: string;
	    editable: boolean;
	    formula: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Column(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.key = source["key"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.editable = source["editable"];
	        this.formula = source["formula"];
	    }
	}
	export class Group {
	    key: Cell;
	    start: number;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new Group(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = this.convertValues(source["key"], Cell);
	        this.start = source["start"];
	        this.count = source["count"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Row {
	    path: string;
	    hash: string;
	    cells: Cell[];
	
	    static createFrom(source: any = {}) {
	        return new Row(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.hash = source["hash"];
	        this.cells = this.convertValues(source["cells"], Cell);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Result {
	    view: string;
	    type: string;
	    columns: Column[];
	    rows: Row[];
	    groups: Group[];
	    total: number;
	    summaries: Cell[];
	    notices: string[];
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.view = source["view"];
	        this.type = source["type"];
	        this.columns = this.convertValues(source["columns"], Column);
	        this.rows = this.convertValues(source["rows"], Row);
	        this.groups = this.convertValues(source["groups"], Group);
	        this.total = source["total"];
	        this.summaries = this.convertValues(source["summaries"], Cell);
	        this.notices = source["notices"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class SortSpec {
	    property: string;
	    direction: string;
	
	    static createFrom(source: any = {}) {
	        return new SortSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.property = source["property"];
	        this.direction = source["direction"];
	    }
	}

}

export namespace composer {
	
	export class ExtractOptions {
	    sourcePath: string;
	    selection: string;
	    title: string;
	    dir: string;
	    embed: boolean;
	    carryFrontmatter: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ExtractOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourcePath = source["sourcePath"];
	        this.selection = source["selection"];
	        this.title = source["title"];
	        this.dir = source["dir"];
	        this.embed = source["embed"];
	        this.carryFrontmatter = source["carryFrontmatter"];
	    }
	}
	export class ExtractResult {
	    path: string;
	    link: string;
	
	    static createFrom(source: any = {}) {
	        return new ExtractResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.link = source["link"];
	    }
	}
	export class MergePlan {
	    source: string;
	    target: string;
	    notes: number;
	    links: number;
	
	    static createFrom(source: any = {}) {
	        return new MergePlan(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.target = source["target"];
	        this.notes = source["notes"];
	        this.links = source["links"];
	    }
	}
	export class MergeResult {
	    source: string;
	    target: string;
	    notes: number;
	    links: number;
	    trashed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MergeResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.target = source["target"];
	        this.notes = source["notes"];
	        this.links = source["links"];
	        this.trashed = source["trashed"];
	    }
	}

}

export namespace graph {
	
	export class Edge {
	    source: number;
	    target: number;
	
	    static createFrom(source: any = {}) {
	        return new Edge(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.target = source["target"];
	    }
	}
	export class Node {
	    id: string;
	    label: string;
	    kind: string;
	    path: string;
	    degree: number;
	    created: number;
	    groups?: number[];
	
	    static createFrom(source: any = {}) {
	        return new Node(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.kind = source["kind"];
	        this.path = source["path"];
	        this.degree = source["degree"];
	        this.created = source["created"];
	        this.groups = source["groups"];
	    }
	}
	export class Graph {
	    nodes: Node[];
	    edges: Edge[];
	    truncated: boolean;
	    total: number;
	
	    static createFrom(source: any = {}) {
	        return new Graph(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.nodes = this.convertValues(source["nodes"], Node);
	        this.edges = this.convertValues(source["edges"], Edge);
	        this.truncated = source["truncated"];
	        this.total = source["total"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Options {
	    query: string;
	    tags: string[];
	    folders: string[];
	    excludeFolders: string[];
	    showOrphans: boolean;
	    showGhosts: boolean;
	    showAttachments: boolean;
	    showTags: boolean;
	    center: string;
	    depth: number;
	    direction: string;
	    groups: string[];
	    maxNodes: number;
	
	    static createFrom(source: any = {}) {
	        return new Options(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.tags = source["tags"];
	        this.folders = source["folders"];
	        this.excludeFolders = source["excludeFolders"];
	        this.showOrphans = source["showOrphans"];
	        this.showGhosts = source["showGhosts"];
	        this.showAttachments = source["showAttachments"];
	        this.showTags = source["showTags"];
	        this.center = source["center"];
	        this.depth = source["depth"];
	        this.direction = source["direction"];
	        this.groups = source["groups"];
	        this.maxNodes = source["maxNodes"];
	    }
	}

}

export namespace history {
	
	export class Snapshot {
	    id: string;
	    path: string;
	    // Go type: time
	    time: any;
	    size: number;
	    hash: string;
	    reason: string;
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path = source["path"];
	        this.time = this.convertValues(source["time"], null);
	        this.size = source["size"];
	        this.hash = source["hash"];
	        this.reason = source["reason"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Content {
	    snapshot: Snapshot;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new Content(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.snapshot = this.convertValues(source["snapshot"], Snapshot);
	        this.content = source["content"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Deleted {
	    path: string;
	    snapshotId: string;
	    // Go type: time
	    time: any;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new Deleted(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.snapshotId = source["snapshotId"];
	        this.time = this.convertValues(source["time"], null);
	        this.size = source["size"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Settings {
	    intervalMinutes: number;
	    retentionDays: number;
	    maxFileMb: number;
	    maxTotalMb: number;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.intervalMinutes = source["intervalMinutes"];
	        this.retentionDays = source["retentionDays"];
	        this.maxFileMb = source["maxFileMb"];
	        this.maxTotalMb = source["maxTotalMb"];
	    }
	}

}

export namespace importer {
	
	export class CSVOptions {
	    delimiter: string;
	    noHeader: boolean;
	    titleColumn: string;
	    bodyColumn: string;
	
	    static createFrom(source: any = {}) {
	        return new CSVOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.delimiter = source["delimiter"];
	        this.noHeader = source["noHeader"];
	        this.titleColumn = source["titleColumn"];
	        this.bodyColumn = source["bodyColumn"];
	    }
	}
	export class Item {
	    kind: string;
	    source: string;
	    dest: string;
	    title: string;
	    reason: string;
	
	    static createFrom(source: any = {}) {
	        return new Item(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.source = source["source"];
	        this.dest = source["dest"];
	        this.title = source["title"];
	        this.reason = source["reason"];
	    }
	}
	export class Options {
	    targetFolder: string;
	    useWikilinks: boolean;
	    attachmentsFolder: string;
	    includeArchived: boolean;
	    includeTrashed: boolean;
	    csv: CSVOptions;
	
	    static createFrom(source: any = {}) {
	        return new Options(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.targetFolder = source["targetFolder"];
	        this.useWikilinks = source["useWikilinks"];
	        this.attachmentsFolder = source["attachmentsFolder"];
	        this.includeArchived = source["includeArchived"];
	        this.includeTrashed = source["includeTrashed"];
	        this.csv = this.convertValues(source["csv"], CSVOptions);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Preview {
	    notes: number;
	    attachments: number;
	    titles: string[];
	    warnings: string[];
	    targetFolder: string;
	    columns: string[];
	    delimiter: string;
	
	    static createFrom(source: any = {}) {
	        return new Preview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.notes = source["notes"];
	        this.attachments = source["attachments"];
	        this.titles = source["titles"];
	        this.warnings = source["warnings"];
	        this.targetFolder = source["targetFolder"];
	        this.columns = source["columns"];
	        this.delimiter = source["delimiter"];
	    }
	}
	export class Report {
	    sourceId: string;
	    folder: string;
	    reportPath: string;
	    startedAt: string;
	    finishedAt: string;
	    cancelled: boolean;
	    notesCreated: number;
	    attachmentsCreated: number;
	    created: Item[];
	    createdTruncated: boolean;
	    skipped: Item[];
	    failed: Item[];
	    linksRewritten: number;
	    linksUnresolved: number;
	    warnings: string[];
	
	    static createFrom(source: any = {}) {
	        return new Report(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sourceId = source["sourceId"];
	        this.folder = source["folder"];
	        this.reportPath = source["reportPath"];
	        this.startedAt = source["startedAt"];
	        this.finishedAt = source["finishedAt"];
	        this.cancelled = source["cancelled"];
	        this.notesCreated = source["notesCreated"];
	        this.attachmentsCreated = source["attachmentsCreated"];
	        this.created = this.convertValues(source["created"], Item);
	        this.createdTruncated = source["createdTruncated"];
	        this.skipped = this.convertValues(source["skipped"], Item);
	        this.failed = this.convertValues(source["failed"], Item);
	        this.linksRewritten = source["linksRewritten"];
	        this.linksUnresolved = source["linksUnresolved"];
	        this.warnings = source["warnings"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SourceInfo {
	    id: string;
	    input: string;
	    extensions: string[];
	
	    static createFrom(source: any = {}) {
	        return new SourceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.input = source["input"];
	        this.extensions = source["extensions"];
	    }
	}

}

export namespace links {
	
	export class Edit {
	    line: number;
	    start: number;
	    end: number;
	    old: string;
	    new: string;
	
	    static createFrom(source: any = {}) {
	        return new Edit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.start = source["start"];
	        this.end = source["end"];
	        this.old = source["old"];
	        this.new = source["new"];
	    }
	}
	export class FileEdit {
	    path: string;
	    hash: string;
	    edits: Edit[];
	
	    static createFrom(source: any = {}) {
	        return new FileEdit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.hash = source["hash"];
	        this.edits = this.convertValues(source["edits"], Edit);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Link {
	    path: string;
	    line: number;
	    raw: string;
	    heading: string;
	    block: string;
	    alias: string;
	    embed: boolean;
	    resolved: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Link(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.line = source["line"];
	        this.raw = source["raw"];
	        this.heading = source["heading"];
	        this.block = source["block"];
	        this.alias = source["alias"];
	        this.embed = source["embed"];
	        this.resolved = source["resolved"];
	    }
	}
	export class Mention {
	    path: string;
	    snippet: string;
	
	    static createFrom(source: any = {}) {
	        return new Mention(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.snippet = source["snippet"];
	    }
	}
	export class Move {
	    from: string;
	    to: string;
	
	    static createFrom(source: any = {}) {
	        return new Move(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.to = source["to"];
	    }
	}
	export class Plan {
	    from: string;
	    to: string;
	    moves: Move[];
	    files: FileEdit[];
	
	    static createFrom(source: any = {}) {
	        return new Plan(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.to = source["to"];
	        this.moves = this.convertValues(source["moves"], Move);
	        this.files = this.convertValues(source["files"], FileEdit);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Suggestion {
	    kind: string;
	    label: string;
	    path: string;
	    detail: string;
	    line: number;
	    score: number;
	
	    static createFrom(source: any = {}) {
	        return new Suggestion(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.label = source["label"];
	        this.path = source["path"];
	        this.detail = source["detail"];
	        this.line = source["line"];
	        this.score = source["score"];
	    }
	}

}

export namespace search {
	
	export class Hit {
	    path: string;
	    title: string;
	    snippet: string;
	    line: number;
	    matches: number;
	    score: number;
	
	    static createFrom(source: any = {}) {
	        return new Hit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.title = source["title"];
	        this.snippet = source["snippet"];
	        this.line = source["line"];
	        this.matches = source["matches"];
	        this.score = source["score"];
	    }
	}
	export class Results {
	    hits: Hit[];
	    total: number;
	    explain: string[];
	
	    static createFrom(source: any = {}) {
	        return new Results(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hits = this.convertValues(source["hits"], Hit);
	        this.total = source["total"];
	        this.explain = source["explain"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace sync {
	
	export class Conflict {
	    id: number;
	    fileId: string;
	    path: string;
	    copyPath: string;
	    strategy: string;
	    localHash: string;
	    remoteRev: number;
	    detail: string;
	    // Go type: time
	    createdAt: any;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new Conflict(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.fileId = source["fileId"];
	        this.path = source["path"];
	        this.copyPath = source["copyPath"];
	        this.strategy = source["strategy"];
	        this.localHash = source["localHash"];
	        this.remoteRev = source["remoteRev"];
	        this.detail = source["detail"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.status = source["status"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LinkInfo {
	    linked: boolean;
	    cloudVaultId: string;
	    kind: string;
	    name: string;
	    serverUrl: string;
	    locked: boolean;
	    paused: boolean;
	    pollSeconds: number;
	    mount: boolean;
	    permission: string;
	    readOnly: boolean;
	    revoked: boolean;
	    ownerName: string;
	    shareId: string;
	
	    static createFrom(source: any = {}) {
	        return new LinkInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.linked = source["linked"];
	        this.cloudVaultId = source["cloudVaultId"];
	        this.kind = source["kind"];
	        this.name = source["name"];
	        this.serverUrl = source["serverUrl"];
	        this.locked = source["locked"];
	        this.paused = source["paused"];
	        this.pollSeconds = source["pollSeconds"];
	        this.mount = source["mount"];
	        this.permission = source["permission"];
	        this.readOnly = source["readOnly"];
	        this.revoked = source["revoked"];
	        this.ownerName = source["ownerName"];
	        this.shareId = source["shareId"];
	    }
	}
	export class LinkResult {
	    cloudVaultId: string;
	    recoveryKey: string;
	
	    static createFrom(source: any = {}) {
	        return new LinkResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cloudVaultId = source["cloudVaultId"];
	        this.recoveryKey = source["recoveryKey"];
	    }
	}
	export class MountState {
	    shareId: string;
	    cloudVaultId: string;
	    name: string;
	    ownerName: string;
	    resourceType: string;
	    permission: string;
	    path: string;
	    mounted: boolean;
	    revoked: boolean;
	    vaultId: string;
	
	    static createFrom(source: any = {}) {
	        return new MountState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.shareId = source["shareId"];
	        this.cloudVaultId = source["cloudVaultId"];
	        this.name = source["name"];
	        this.ownerName = source["ownerName"];
	        this.resourceType = source["resourceType"];
	        this.permission = source["permission"];
	        this.path = source["path"];
	        this.mounted = source["mounted"];
	        this.revoked = source["revoked"];
	        this.vaultId = source["vaultId"];
	    }
	}
	export class RevisionInfo {
	    rev: number;
	    op: string;
	    path: string;
	    size: number;
	    authorId: string;
	    deviceId: string;
	    // Go type: time
	    time: any;
	    hasContent: boolean;
	    mine: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RevisionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rev = source["rev"];
	        this.op = source["op"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.authorId = source["authorId"];
	        this.deviceId = source["deviceId"];
	        this.time = this.convertValues(source["time"], null);
	        this.hasContent = source["hasContent"];
	        this.mine = source["mine"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Status {
	    vaultId: string;
	    phase: string;
	    // Go type: time
	    lastSync: any;
	    pending: number;
	    conflicts: number;
	    done: number;
	    total: number;
	    error: string;
	    kind: string;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.vaultId = source["vaultId"];
	        this.phase = source["phase"];
	        this.lastSync = this.convertValues(source["lastSync"], null);
	        this.pending = source["pending"];
	        this.conflicts = source["conflicts"];
	        this.done = source["done"];
	        this.total = source["total"];
	        this.error = source["error"];
	        this.kind = source["kind"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace updater {
	
	export class Result {
	    method: string;
	    quit: boolean;
	    path: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.method = source["method"];
	        this.quit = source["quit"];
	        this.path = source["path"];
	        this.message = source["message"];
	    }
	}
	export class Settings {
	    enabled: boolean;
	    channel: string;
	    skippedVersion: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.channel = source["channel"];
	        this.skippedVersion = source["skippedVersion"];
	    }
	}
	export class Status {
	    state: string;
	    current: string;
	    latest: string;
	    channel: string;
	    notes: string;
	    notesUrl: string;
	    // Go type: time
	    released: any;
	    required: boolean;
	    skipped: boolean;
	    kind: string;
	    size: number;
	    done: number;
	    error: string;
	    // Go type: time
	    checkedAt: any;
	    disabled: string;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.current = source["current"];
	        this.latest = source["latest"];
	        this.channel = source["channel"];
	        this.notes = source["notes"];
	        this.notesUrl = source["notesUrl"];
	        this.released = this.convertValues(source["released"], null);
	        this.required = source["required"];
	        this.skipped = source["skipped"];
	        this.kind = source["kind"];
	        this.size = source["size"];
	        this.done = source["done"];
	        this.error = source["error"];
	        this.checkedAt = this.convertValues(source["checkedAt"], null);
	        this.disabled = source["disabled"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace vault {
	
	export class Entry {
	    path: string;
	    name: string;
	    isDir: boolean;
	    kind: string;
	    size: number;
	    // Go type: time
	    mtime: any;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.isDir = source["isDir"];
	        this.kind = source["kind"];
	        this.size = source["size"];
	        this.mtime = this.convertValues(source["mtime"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

