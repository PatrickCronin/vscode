/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { isPromiseCanceledError } from 'vs/base/common/errors';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { URI, UriComponents } from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { localize } from 'vs/nls';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { ILabelService } from 'vs/platform/label/common/label';
import { IFolderQuery, IPatternInfo, IQueryOptions, ISearchConfiguration, ISearchProgressItem, ISearchQuery, ISearchService, QueryType } from 'vs/platform/search/common/search';
import { IStatusbarService } from 'vs/platform/statusbar/common/statusbar';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { extHostNamedCustomer } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { QueryBuilder } from 'vs/workbench/parts/search/common/queryBuilder';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import { ExtHostContext, ExtHostWorkspaceShape, IExtHostContext, MainContext, MainThreadWorkspaceShape } from '../node/extHost.protocol';
import { CancellationTokenSource } from 'vs/base/common/cancellation';

@extHostNamedCustomer(MainContext.MainThreadWorkspace)
export class MainThreadWorkspace implements MainThreadWorkspaceShape {

	private readonly _toDispose: IDisposable[] = [];
	private readonly _activeCancelTokens: { [id: number]: CancellationTokenSource } = Object.create(null);
	private readonly _proxy: ExtHostWorkspaceShape;

	constructor(
		extHostContext: IExtHostContext,
		@ISearchService private readonly _searchService: ISearchService,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceEditingService private readonly _workspaceEditingService: IWorkspaceEditingService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILabelService private readonly _labelService: ILabelService
	) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostWorkspace);
		this._contextService.onDidChangeWorkspaceFolders(this._onDidChangeWorkspace, this, this._toDispose);
		this._contextService.onDidChangeWorkbenchState(this._onDidChangeWorkspace, this, this._toDispose);
	}

	dispose(): void {
		dispose(this._toDispose);

		for (let requestId in this._activeCancelTokens) {
			const tokenSource = this._activeCancelTokens[requestId];
			tokenSource.cancel();
		}
	}

	// --- workspace ---

	$updateWorkspaceFolders(extensionName: string, index: number, deleteCount: number, foldersToAdd: { uri: UriComponents, name?: string }[]): Thenable<void> {
		const workspaceFoldersToAdd = foldersToAdd.map(f => ({ uri: URI.revive(f.uri), name: f.name }));

		// Indicate in status message
		this._statusbarService.setStatusMessage(this.getStatusMessage(extensionName, workspaceFoldersToAdd.length, deleteCount), 10 * 1000 /* 10s */);

		return this._workspaceEditingService.updateFolders(index, deleteCount, workspaceFoldersToAdd, true);
	}

	private getStatusMessage(extensionName: string, addCount: number, removeCount: number): string {
		let message: string;

		const wantsToAdd = addCount > 0;
		const wantsToDelete = removeCount > 0;

		// Add Folders
		if (wantsToAdd && !wantsToDelete) {
			if (addCount === 1) {
				message = localize('folderStatusMessageAddSingleFolder', "Extension '{0}' added 1 folder to the workspace", extensionName);
			} else {
				message = localize('folderStatusMessageAddMultipleFolders', "Extension '{0}' added {1} folders to the workspace", extensionName, addCount);
			}
		}

		// Delete Folders
		else if (wantsToDelete && !wantsToAdd) {
			if (removeCount === 1) {
				message = localize('folderStatusMessageRemoveSingleFolder', "Extension '{0}' removed 1 folder from the workspace", extensionName);
			} else {
				message = localize('folderStatusMessageRemoveMultipleFolders', "Extension '{0}' removed {1} folders from the workspace", extensionName, removeCount);
			}
		}

		// Change Folders
		else {
			message = localize('folderStatusChangeFolder', "Extension '{0}' changed folders of the workspace", extensionName);
		}

		return message;
	}

	private _onDidChangeWorkspace(): void {
		const workspace = this._contextService.getWorkbenchState() === WorkbenchState.EMPTY ? null : this._contextService.getWorkspace();
		this._proxy.$acceptWorkspaceData(workspace ? {
			configuration: workspace.configuration,
			folders: workspace.folders,
			id: workspace.id,
			name: this._labelService.getWorkspaceLabel(workspace)
		} : null);
	}

	// --- search ---

	$startFileSearch(includePattern: string, includeFolder: string, excludePatternOrDisregardExcludes: string | false, maxResults: number, requestId: number): Thenable<URI[]> {
		const workspace = this._contextService.getWorkspace();
		if (!workspace.folders.length) {
			return undefined;
		}

		let folderQueries: IFolderQuery[];
		if (typeof includeFolder === 'string') {
			folderQueries = [{ folder: URI.file(includeFolder) }]; // if base provided, only search in that folder
		} else {
			folderQueries = workspace.folders.map(folder => ({ folder: folder.uri })); // absolute pattern: search across all folders
		}

		if (!folderQueries) {
			return undefined; // invalid query parameters
		}

		const useRipgrep = folderQueries.every(folderQuery => {
			const folderConfig = this._configurationService.getValue<ISearchConfiguration>({ resource: folderQuery.folder });
			return folderConfig.search.useRipgrep;
		});

		const ignoreSymlinks = folderQueries.every(folderQuery => {
			const folderConfig = this._configurationService.getValue<ISearchConfiguration>({ resource: folderQuery.folder });
			return !folderConfig.search.followSymlinks;
		});

		const query: ISearchQuery = {
			folderQueries,
			type: QueryType.File,
			maxResults,
			disregardExcludeSettings: excludePatternOrDisregardExcludes === false,
			useRipgrep,
			ignoreSymlinks
		};
		if (typeof includePattern === 'string') {
			query.includePattern = { [includePattern]: true };
		}

		if (typeof excludePatternOrDisregardExcludes === 'string') {
			query.excludePattern = { [excludePatternOrDisregardExcludes]: true };
		}

		this._searchService.extendQuery(query);

		const tokenSource = new CancellationTokenSource();
		const search = this._searchService.search(query, tokenSource.token).then(result => {
			return result.results.map(m => m.resource);
		}, err => {
			if (!isPromiseCanceledError(err)) {
				return TPromise.wrapError(err);
			}
			return undefined;
		});

		this._activeCancelTokens[requestId] = tokenSource;
		const onDone = () => {
			tokenSource.dispose();
			delete this._activeCancelTokens[requestId];
		};
		search.then(onDone, onDone);

		return search;
	}

	$startTextSearch(pattern: IPatternInfo, options: IQueryOptions, requestId: number): TPromise<void> {
		const workspace = this._contextService.getWorkspace();
		const folders = workspace.folders.map(folder => folder.uri);

		const queryBuilder = this._instantiationService.createInstance(QueryBuilder);
		const query = queryBuilder.text(pattern, folders, options);

		const onProgress = (p: ISearchProgressItem) => {
			if (p.matches) {
				this._proxy.$handleTextSearchResult(p, requestId);
			}
		};

		const tokenSource = new CancellationTokenSource();
		const search = this._searchService.search(query, tokenSource.token, onProgress).then(
			() => {
				return null;
			},
			err => {
				if (!isPromiseCanceledError(err)) {
					return TPromise.wrapError(err);
				}

				return undefined;
			});

		this._activeCancelTokens[requestId] = tokenSource;
		const onDone = () => {
			tokenSource.dispose();
			delete this._activeCancelTokens[requestId];
		};
		search.then(onDone, onDone);

		return search;
	}

	$checkExists(query: ISearchQuery, requestId: number): TPromise<boolean> {
		query.exists = true;

		const tokenSource = new CancellationTokenSource();
		const search = this._searchService.search(query, tokenSource.token).then(
			result => {
				delete this._activeCancelTokens[requestId];
				return result.limitHit;
			},
			err => {
				delete this._activeCancelTokens[requestId];
				if (!isPromiseCanceledError(err)) {
					return TPromise.wrapError(err);
				}

				return undefined;
			});

		this._activeCancelTokens[requestId] = tokenSource;

		return search;
	}

	$cancelSearch(requestId: number): Thenable<boolean> {
		const tokenSource = this._activeCancelTokens[requestId];
		if (tokenSource) {
			delete this._activeCancelTokens[requestId];
			tokenSource.cancel();
			return TPromise.as(true);
		}
		return undefined;
	}

	// --- save & edit resources ---

	$saveAll(includeUntitled?: boolean): Thenable<boolean> {
		return this._textFileService.saveAll(includeUntitled).then(result => {
			return result.results.every(each => each.success === true);
		});
	}
}

CommandsRegistry.registerCommand('_workbench.enterWorkspace', async function (accessor: ServicesAccessor, workspace: URI, disableExtensions: string[]) {
	const workspaceEditingService = accessor.get(IWorkspaceEditingService);
	const extensionService = accessor.get(IExtensionService);
	const windowService = accessor.get(IWindowService);

	if (disableExtensions && disableExtensions.length) {
		const runningExtensions = await extensionService.getExtensions();
		// If requested extension to disable is running, then reload window with given workspace
		if (disableExtensions && runningExtensions.some(runningExtension => disableExtensions.some(id => areSameExtensions({ id }, { id: runningExtension.id })))) {
			return windowService.openWindow([URI.file(workspace.fsPath)], { args: { _: [], 'disable-extension': disableExtensions } });
		}
	}

	return workspaceEditingService.enterWorkspace(workspace.fsPath);
});
