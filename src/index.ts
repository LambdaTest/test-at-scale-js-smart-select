#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from "path";
import parser from "yargs-parser";
import type { FS as HasteFS } from "jest-haste-map";
import HM from "jest-haste-map";
import type { Config } from '@jest/types';
import Resolver from 'jest-resolve';
import { hideBin } from "yargs/helpers";
import {stringifyStream, parseChunked} from "@discoveryjs/json-ext";
import { Readable } from "stream";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SourceMapResolve = require("source-map-resolve");

const TAS_DIRECTORY = process.cwd() + "/__tas";
const OUT_FILE = TAS_DIRECTORY + "/out.json";

class Task<T = void> {
    protected _promise: Promise<T>;
    private resolveFn!: (value: PromiseLike<T> | T) => void;
    private rejectFn!: (reason: any) => void;
    private _isCompleted = false;

    constructor() {
        this._promise = new Promise<T>((resolve, reject) => {
            this.resolveFn = resolve;
            this.rejectFn = reject;
        });
    }

    public get promise(): Promise<T> {
        return this._promise;
    }

    public get isCompleted(): boolean {
        return this._isCompleted;
    }

    public resolve = (result: PromiseLike<T> | T): void => {
        this._isCompleted = true;
        this.resolveFn(result);
    };

    public reject: (reason: any) => void = (reason: any): void => {
        this._isCompleted = true;
        this.rejectFn(reason);
    };
}

type TestsDependenciesMap = Map<string, Set<string>>;

class TestDependencies {
    testFile: string;
    dependsOn: string[];
    constructor(testFile: string, dependsOn: string[]) {
        this.testFile = testFile;
        this.dependsOn = dependsOn;
    }
}

class JSONStream {
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    static async stringify(value: any, dest: any, replacer?: any, space?: string | number): Promise<string> {
        return new Promise((resolve, reject) => {
            stringifyStream(value, replacer, space)
                .on('error', reject)
                .pipe(dest)
                .on('error', reject)
                .on('finish', resolve);
        });
    }

    static async parse(input: Readable): Promise<any> {
        return parseChunked(input);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    static replacer = (_: string, value: any): any => {
        if (value instanceof Map) {
            return Object.fromEntries(value);
        }
        if (value instanceof Set) {
            return Array.from(value);
        }
        return value;
    };
}

class SmartSelect {
    private hasteFS?: HasteFS;
    private resolver?: Resolver;
    private fileGraph = new Map<string, Set<string>>();

    private static _self: SmartSelect;

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    private constructor() {}

    static getInstance(): SmartSelect {
        return this._self || (this._self = new SmartSelect());
    }

    async listDependencies(testFiles: string[], includeSelf: boolean): Promise<TestsDependenciesMap> {
        const rootDir = process.cwd();
        if (!this.hasteFS || !this.resolver) {
            const [hasteFS, resolver] = await this.buildHasteMap(rootDir);
            this.hasteFS = hasteFS;
            this.resolver = resolver;
        }
        const promises: Promise<TestDependencies>[] = [];
        for (let i = 0; i < testFiles.length; i++) {
            promises.push(this.listDependency(testFiles[i], rootDir));
        }
        const testDeps: TestDependencies[] = [];
        await Promise.all(promises);
        for (let i = 0; i < testFiles.length; i++) {
            const deps = this.toTestsDependenciesMap(testFiles[i]);
            if (includeSelf) {
                deps.push(testFiles[i]);
            }
            const depsRel: string[] = [];
            for (const dep of deps) {
                try {
                    if (dep.startsWith(rootDir)) {
                        const repoRelativePath = path.relative(rootDir, dep);
                        depsRel.push(repoRelativePath);
                    }
                } catch {
                    // ignore deps that cannot be resolved
                }
            }
            const testDep = new TestDependencies(testFiles[i], depsRel);
            testDeps.push(testDep);
        }
        return SmartSelect.toTestDependenciesMap(testDeps);
    }

    private toTestsDependenciesMap(file: string): string[] {
        const processed = new Set<string>();
        const deps = this.fileGraph.get(file);
        if (!deps) {
            return [];
        }
        const results: string[] = [];
        for (const dep of deps) {
            results.push(dep);
            processed.add(dep);
        }
        let i = 0;
        while (i < results.length) {
            const topItem = results[i++];
            const items = Array.from(
                this.fileGraph.get(topItem) ?? new Set<string>())
                .filter(item => !processed.has(item));
            for (const item of items) {
                results.push(item);
                processed.add(item);
            }
        }
        return results;
    }

    private async listDependency(
        testFile: string,
        rootDir: string,
        config?: Config.ProjectConfig,
    ): Promise<TestDependencies> {
        const modDirs: Array<string> =
            config && config.moduleDirectories
                ? Array.from(config.moduleDirectories)
                : ['node_modules'];

        const result: string[] = [];
        let explore = [testFile];
        while (explore.length > 0) {
            const file = explore.pop() as string;
            const children = await this.extractDeps(file, rootDir, modDirs);
            explore = explore.concat(Array.from(children));
        }
        const currDeps = this.fileGraph.get(testFile);
        if (currDeps) {
            for (const dep of currDeps) {
                try {
                    if (dep.startsWith(rootDir)) {
                        const repoRelativePath = path.relative(rootDir, dep);
                        result.push(repoRelativePath);
                    }
                } catch {
                    // ignore deps that cannot be resolved
                }
            }
        }
        return new TestDependencies(testFile, result);
    }

    private async extractDeps(
        file: string,
        rootDir: string,
        modDirs: Array<string>,
        config?: Config.ProjectConfig,
    ): Promise<Set<string>> {
        if (this.fileGraph.has(file)) {
            // already visited or currently visiting by another "file", therefore skip and return
            return new Set<string>();
        }
        this.fileGraph.set(file, new Set<string>());
        if (!this.hasteFS || !this.resolver) {
            const [hasteFS, resolver] = await this.buildHasteMap(rootDir, config);
            this.hasteFS = hasteFS;
            this.resolver = resolver;
        }
        const dependencies = this.hasteFS.getDependencies(file);
        if (!dependencies) {
            return new Set<string>();
        }
        for (const dependency of dependencies) {
            // ignore the nodejs core modules.
            if (this.resolver.isCoreModule(dependency)) {
                continue;
            }
            let resolvedDependency;
            let resolvedMockDependency;
            try {
                resolvedDependency = this.resolver.resolveModule(file, dependency,
                    { skipNodeResolution: config && config.skipNodeResolution });
            } catch {
                try {
                    resolvedDependency = this.resolver.getMockModule(file, dependency);
                } catch {
                    // leave resolvedDependency as undefined if nothing can be found
                }
            }
            if (!resolvedDependency) {
                continue;
            }
            const strResolvedDependency = String(resolvedDependency)
            // if dependency inside module directories. we ignore it
            const matches = modDirs.find(el => strResolvedDependency.includes(el));
            if (matches) {
                continue;
            }
            try {
                // check if source file exists
                const resolvedSources = await SmartSelect.getResolvedSources(resolvedDependency);
                const currDeps = this.fileGraph.get(file);
                if (!!currDeps && !currDeps.has(resolvedDependency)) {
                    // put resolvedSources of childItem if present, else put childItem; but not both
                    if (resolvedSources.length > 0) {
                        for (const resolvedSource of resolvedSources) {
                            currDeps.add(resolvedSource);
                        }
                        // if it has source files, we skip mock repo items.
                        continue;
                    } else {
                        currDeps.add(resolvedDependency)
                    }
                }
            } catch {
                this.fileGraph.get(file)?.add(resolvedDependency);
            }

            // If we resolve a dependency, then look for a mock dependency
            // of the same name in that dependency's directory.
            try {
                resolvedMockDependency = this.resolver.getMockModule(
                    resolvedDependency,
                    path.basename(dependency),
                );
            } catch {
                // leave resolvedMockDependency as undefined if nothing can be found
            }

            if (resolvedMockDependency) {
                const dependencyMockDir = path.resolve(
                    path.dirname(resolvedDependency),
                    '__mocks__',
                );
                resolvedMockDependency = path.resolve(resolvedMockDependency);
                // make sure mock is in the correct directory
                if (dependencyMockDir === path.dirname(resolvedMockDependency)) {
                    this.fileGraph.get(file)?.add(resolvedDependency);
                }
            }
        }
        return this.fileGraph.get(file) ?? new Set<string>();
    }

    private static async getResolvedSources(file: string): Promise<string[]> {
        const resolvedSourceTask = new Task<string[]>();
        const code = (await fs.promises.readFile(file)).toString();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        SourceMapResolve.resolve(code, file, fs.readFile, function(error: any, result: any) {
            if (error) {
                console.error(error);
                resolvedSourceTask.resolve([]);
            }
            resolvedSourceTask.resolve((result ?? {}).sourcesResolved ?? []);
        });
        return resolvedSourceTask.promise;
    }

    private async buildHasteMap(rootDir: string, config?: Config.ProjectConfig): Promise<[HasteFS, Resolver]> {
        const extensions: Array<string> =
            config && config.moduleFileExtensions
                ? Array.from(config.moduleFileExtensions)
                : ['js', 'json', 'jsx', 'ts', 'tsx', 'node'];
        const modDirs: Array<string> =
            config && config.moduleDirectories
                ? Array.from(config.moduleDirectories)
                : ['node_modules'];
        // can add ignore patterns: https://github.com/facebook/jest/blob/main/packages/jest-runtime/src/index.ts#L359
        const hm = await HM.create({
            extensions: extensions,
            platforms: [],
            computeDependencies: true,
            maxWorkers: 1,
            id: 'test-at-scale',
            resetCache: false,
            rootDir: rootDir,
            roots: [rootDir],
            useWatchman: true,
            throwOnModuleCollision: false,
            retainAllFiles: false
        });
        const o = await hm.build();

        // https://github.com/facebook/jest/blob/main/packages/jest-runtime/src/index.ts#L395
        const resolver = new Resolver(o.moduleMap, {
            rootDir: rootDir,
            hasCoreModules: true,
            extensions: extensions.map(extension => '.' + extension),
            platforms: config && config.haste.platforms ? config.haste.platforms : undefined,
            moduleDirectories: modDirs,
        });

        return [o.hasteFS, resolver];
    }

    private static toTestDependenciesMap(testDependencies: TestDependencies[]): TestsDependenciesMap {
        const testsDepsMap = new Map<string, Set<string>>();
        for (const testDependency of testDependencies) {
            testsDepsMap.set(testDependency.testFile, new Set(testDependency.dependsOn));
        }
        return testsDepsMap;
    }

    public async callFn(inputFile: string): Promise<TestDependencies | TestsDependenciesMap> {
        const argv = JSON.parse(fs.readFileSync(inputFile).toString());
        const includeSelf = (argv.includeSelf as boolean) ?? false;
        let result: TestDependencies | TestsDependenciesMap | null = null;
        if (argv.function === "listDependencies") {
            const testFiles = argv.testFiles as string[];
            result = await this.listDependencies(testFiles, includeSelf);
        } else {
            throw Error("Unknown/Not implemented function")
        }
        fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
        await JSONStream.stringify(
            result,
            fs.createWriteStream(OUT_FILE),
            JSONStream.replacer
        );
        return result;
    }
}

(async () => {
    const instance = SmartSelect.getInstance();
    try {
        const argv = parser(hideBin(process.argv));
        if (argv.ping) {
            console.log("pong");
        } else {
            await instance.callFn(argv.inputFile);
        }
    } catch (e: any) {
        console.error(e.stack);
        process.exit(-1);
    }
    process.exit(0);
})();
