/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { equals } from 'vs/base/common/objects';
import { compare, toValuesTree, IConfigurationChangeEvent, ConfigurationTarget, IConfigurationModel, IConfigurationOverrides, IOverrides } from 'vs/platform/configuration/common/configuration';
import { Configuration as BaseConfiguration, ConfigurationModelParser, ConfigurationChangeEvent, ConfigurationModel, AbstractConfigurationChangeEvent } from 'vs/platform/configuration/common/configurationModels';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, IConfigurationPropertySchema, Extensions, ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { IStoredWorkspaceFolder } from 'vs/platform/workspaces/common/workspaces';
import { Workspace } from 'vs/platform/workspace/common/workspace';
import { StrictResourceMap } from 'vs/base/common/map';
import URI from 'vs/base/common/uri';

export class WorkspaceSettingsModel extends ConfigurationModel {

	private _unsupportedKeys: string[];

	constructor(contents: any, keys: string[], overrides: IOverrides[], unsupportedKeys: string[]) {
		super(contents, keys, overrides);
		this._unsupportedKeys = unsupportedKeys;
	}

	public get unsupportedKeys(): string[] {
		return this._unsupportedKeys;
	}

}

export class WorkspaceConfigurationModelParser extends ConfigurationModelParser {

	private _folders: IStoredWorkspaceFolder[] = [];
	private _workspaceSettingsModelParser: FolderSettingsModelParser;

	constructor(name: string) {
		super(name);
		this._workspaceSettingsModelParser = new FolderSettingsModelParser(name);
	}

	get folders(): IStoredWorkspaceFolder[] {
		return this._folders;
	}

	get workspaceSettingsModel(): WorkspaceSettingsModel {
		return this._workspaceSettingsModelParser.folderSettingsModel;
	}

	reprocessWorkspaceSettings(): void {
		this._workspaceSettingsModelParser.reprocess();
	}

	protected parseRaw(raw: any): IConfigurationModel {
		this._folders = (raw['folders'] || []) as IStoredWorkspaceFolder[];
		this._workspaceSettingsModelParser.parse(raw['settings']);
		return super.parseRaw(raw);
	}
}

export class StandaloneConfigurationModelParser extends ConfigurationModelParser {

	constructor(name: string, private readonly scope: string) {
		super(name);
	}

	protected parseRaw(raw: any): IConfigurationModel {
		const contents = toValuesTree(raw, message => console.error(`Conflict in settings file ${this._name}: ${message}`));
		const scopedContents = Object.create(null);
		scopedContents[this.scope] = contents;
		const keys = Object.keys(raw).map(key => `${this.scope}.${key}`);
		return { contents: scopedContents, keys, overrides: [] };
	}

}

export class FolderSettingsModelParser extends ConfigurationModelParser {

	private _raw: any;
	private _workspaceSettingsModel: WorkspaceSettingsModel;

	constructor(name: string, private configurationScope?: ConfigurationScope) {
		super(name);
	}

	parse(content: string | any): void {
		this._raw = typeof content === 'string' ? this.parseContent(content) : content;
		this.parseWorkspaceSettings(this._raw);
	}

	get configurationModel(): ConfigurationModel {
		return this._workspaceSettingsModel || new WorkspaceSettingsModel({}, [], [], []);
	}

	get folderSettingsModel(): WorkspaceSettingsModel {
		return <WorkspaceSettingsModel>this.configurationModel;
	}

	reprocess(): void {
		this.parse(this._raw);
	}

	private parseWorkspaceSettings(rawSettings: any): void {
		const unsupportedKeys = [];
		const rawWorkspaceSettings = {};
		const configurationProperties = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties();
		for (let key in rawSettings) {
			if (this.isNotExecutable(key, configurationProperties)) {
				if (this.configurationScope === void 0 || this.getScope(key, configurationProperties) === this.configurationScope) {
					rawWorkspaceSettings[key] = rawSettings[key];
				}
			} else {
				unsupportedKeys.push(key);
			}
		}
		const configurationModel = this.parseRaw(rawWorkspaceSettings);
		this._workspaceSettingsModel = new WorkspaceSettingsModel(configurationModel.contents, configurationModel.keys, configurationModel.overrides, unsupportedKeys);
	}

	private getScope(key: string, configurationProperties: { [qualifiedKey: string]: IConfigurationPropertySchema }): ConfigurationScope {
		const propertySchema = configurationProperties[key];
		return propertySchema ? propertySchema.scope : ConfigurationScope.WINDOW;
	}

	private isNotExecutable(key: string, configurationProperties: { [qualifiedKey: string]: IConfigurationPropertySchema }): boolean {
		const propertySchema = configurationProperties[key];
		if (!propertySchema) {
			return true; // Unknown propertis are ignored from checks
		}
		return !propertySchema.isExecutable;
	}
}

export class Configuration extends BaseConfiguration {

	constructor(
		defaults: ConfigurationModel,
		user: ConfigurationModel,
		workspaceConfiguration: ConfigurationModel,
		folders: StrictResourceMap<ConfigurationModel>,
		memoryConfiguration: ConfigurationModel,
		memoryConfigurationByResource: StrictResourceMap<ConfigurationModel>,
		private readonly _workspace: Workspace) {
		super(defaults, user, workspaceConfiguration, folders, memoryConfiguration, memoryConfigurationByResource);
	}

	getSection<C>(section: string = '', overrides: IConfigurationOverrides = {}): C {
		return super.getSection(section, overrides, this._workspace);
	}

	getValue(key: string, overrides: IConfigurationOverrides = {}): any {
		return super.getValue(key, overrides, this._workspace);
	}

	lookup<C>(key: string, overrides: IConfigurationOverrides = {}): {
		default: C,
		user: C,
		workspace: C,
		workspaceFolder: C
		memory?: C
		value: C,
	} {
		return super.lookup(key, overrides, this._workspace);
	}

	keys(): {
		default: string[];
		user: string[];
		workspace: string[];
		workspaceFolder: string[];
	} {
		return super.keys(this._workspace);
	}

	compareAndUpdateUserConfiguration(user: ConfigurationModel): ConfigurationChangeEvent {
		const { added, updated, removed } = compare(this.user, user);
		let changedKeys = [...added, ...updated, ...removed];
		if (changedKeys.length) {
			const oldValues = changedKeys.map(key => this.getValue(key));
			super.updateUserConfiguration(user);
			changedKeys = changedKeys.filter((key, index) => !equals(oldValues[index], this.getValue(key)));
		}
		return new ConfigurationChangeEvent().change(changedKeys);
	}

	compareAndUpdateWorkspaceConfiguration(workspaceConfiguration: ConfigurationModel): ConfigurationChangeEvent {
		const { added, updated, removed } = compare(this.workspace, workspaceConfiguration);
		let changedKeys = [...added, ...updated, ...removed];
		if (changedKeys.length) {
			const oldValues = changedKeys.map(key => this.getValue(key));
			super.updateWorkspaceConfiguration(workspaceConfiguration);
			changedKeys = changedKeys.filter((key, index) => !equals(oldValues[index], this.getValue(key)));
		}
		return new ConfigurationChangeEvent().change(changedKeys);
	}

	compareAndUpdateFolderConfiguration(resource: URI, folderConfiguration: ConfigurationModel): ConfigurationChangeEvent {
		const currentFolderConfiguration = this.folders.get(resource);
		if (currentFolderConfiguration) {
			const { added, updated, removed } = compare(currentFolderConfiguration, folderConfiguration);
			let changedKeys = [...added, ...updated, ...removed];
			if (changedKeys.length) {
				const oldValues = changedKeys.map(key => this.getValue(key, { resource }));
				super.updateFolderConfiguration(resource, folderConfiguration);
				changedKeys = changedKeys.filter((key, index) => !equals(oldValues[index], this.getValue(key, { resource })));
			}
			return new ConfigurationChangeEvent().change(changedKeys, resource);
		} else {
			super.updateFolderConfiguration(resource, folderConfiguration);
			return new ConfigurationChangeEvent().change(folderConfiguration.keys, resource);
		}
	}

	compareAndDeleteFolderConfiguration(folder: URI): ConfigurationChangeEvent {
		if (this._workspace && this._workspace.folders.length > 0 && this._workspace.folders[0].uri.toString() === folder.toString()) {
			// Do not remove workspace configuration
			return new ConfigurationChangeEvent();
		}
		const keys = this.folders.get(folder).keys;
		super.deleteFolderConfiguration(folder);
		return new ConfigurationChangeEvent().change(keys, folder);
	}

	compare(other: Configuration): string[] {
		let from = other.allKeys();
		let to = this.allKeys();

		const added = to.filter(key => from.indexOf(key) === -1);
		const removed = from.filter(key => to.indexOf(key) === -1);
		const updated = [];

		for (const key of from) {
			const value1 = this.getValue(key);
			const value2 = other.getValue(key);
			if (!equals(value1, value2)) {
				updated.push(key);
			}
		}

		return [...added, ...removed, ...updated];
	}

	allKeys(): string[] {
		return super.allKeys(this._workspace);
	}
}

export class AllKeysConfigurationChangeEvent extends AbstractConfigurationChangeEvent implements IConfigurationChangeEvent {

	private _changedConfiguration: ConfigurationModel = null;

	constructor(private _configuration: Configuration, readonly source: ConfigurationTarget, readonly sourceConfig: any) { super(); }

	get changedConfiguration(): ConfigurationModel {
		if (!this._changedConfiguration) {
			this._changedConfiguration = new ConfigurationModel();
			this.updateKeys(this._changedConfiguration, this.affectedKeys);
		}
		return this._changedConfiguration;
	}

	get changedConfigurationByResource(): StrictResourceMap<IConfigurationModel> {
		return new StrictResourceMap();
	}

	get affectedKeys(): string[] {
		return this._configuration.allKeys();
	}

	affectsConfiguration(config: string, resource?: URI): boolean {
		return this.doesConfigurationContains(this.changedConfiguration, config);
	}
}

export class WorkspaceConfigurationChangeEvent implements IConfigurationChangeEvent {

	constructor(private configurationChangeEvent: IConfigurationChangeEvent, private workspace: Workspace) { }

	get changedConfiguration(): IConfigurationModel {
		return this.configurationChangeEvent.changedConfiguration;
	}

	get changedConfigurationByResource(): StrictResourceMap<IConfigurationModel> {
		return this.configurationChangeEvent.changedConfigurationByResource;
	}

	get affectedKeys(): string[] {
		return this.configurationChangeEvent.affectedKeys;
	}

	get source(): ConfigurationTarget {
		return this.configurationChangeEvent.source;
	}

	get sourceConfig(): any {
		return this.configurationChangeEvent.sourceConfig;
	}

	affectsConfiguration(config: string, resource?: URI): boolean {
		if (this.configurationChangeEvent.affectsConfiguration(config, resource)) {
			return true;
		}

		if (resource && this.workspace) {
			let workspaceFolder = this.workspace.getFolder(resource);
			if (workspaceFolder) {
				return this.configurationChangeEvent.affectsConfiguration(config, workspaceFolder.uri);
			}
		}

		return false;
	}
}