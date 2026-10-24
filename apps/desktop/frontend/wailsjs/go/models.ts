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

