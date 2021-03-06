/*
* server.ts
*
* Implements pyright language server.
*/

import {
    createConnection, Diagnostic, DiagnosticSeverity, DiagnosticTag,
    IConnection, InitializeResult, IPCMessageReader, IPCMessageWriter,
    Location, MarkupContent, Position, Range, TextDocuments
} from 'vscode-languageserver';
import VSCodeUri from 'vscode-uri';

import { AnalyzerService } from './analyzer/service';
import { CommandLineOptions } from './common/commandLineOptions';
import { Diagnostic as AnalyzerDiagnostic, DiagnosticCategory, DiagnosticTextPosition,
    DiagnosticTextRange } from './common/diagnostic';
import { combinePaths, getDirectoryPath, normalizePath } from './common/pathUtils';

interface PythonSettings {
    venvPath?: string;
    pythonPath?: string;
    analysis?: {
        typeshedPaths: string[];
    };
}

interface Settings {
    python: PythonSettings;
}

// Stash the base directory into a global variable.
(global as any).__rootDirectory = getDirectoryPath(__dirname);

// Create a connection for the server. The connection uses Node's IPC as a transport
let _connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

_connection.console.log('Pyright language server starting');

// Create a simple text document manager. The text document manager
// supports full document sync only.
let _documents: TextDocuments = new TextDocuments();

// Allocate the analyzer service instance.
let _analyzerService: AnalyzerService = new AnalyzerService(_connection.console);

// Root path of the workspace.
let _rootPath = '';

// Tracks whether we're currently displaying progress.
let _isDisplayingProgress = false;

// Make the text document manager listen on the connection
// for open, change and close text document events.
_documents.listen(_connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
_connection.onInitialize((params): InitializeResult => {
    _rootPath = params.rootPath || '';

    // Don't allow the analysis engine to go too long without
    // reporting results. This will keep it responsive.
    _analyzerService.setMaxAnalysisDuration({
        openFilesTimeInMs: 50,
        noOpenFilesTimeInMs: 500
    });

    _analyzerService.setCompletionCallback(results => {
        results.diagnostics.forEach(fileDiag => {
            let diagnostics = _convertDiagnostics(fileDiag.diagnostics);

            // Send the computed diagnostics to the client.
            _connection.sendDiagnostics({
                uri: _convertPathToUri(fileDiag.filePath),
                diagnostics
            });

            if (results.filesRequiringAnalysis > 0) {
                if (!_isDisplayingProgress) {
                    _isDisplayingProgress = true;
                    _connection.sendNotification('pyright/beginProgress');
                }

                const fileOrFiles = results.filesRequiringAnalysis !== 1 ? 'files' : 'file';
                _connection.sendNotification('pyright/reportProgress',
                    `${ results.filesRequiringAnalysis } ${ fileOrFiles } to analyze`);
            } else {
                if (_isDisplayingProgress) {
                    _isDisplayingProgress = false;
                    _connection.sendNotification('pyright/endProgress');
                }
            }
        });
    });

    return {
        capabilities: {
            // Tell the client that the server works in FULL text document
            // sync mode (as opposed to incremental).
            textDocumentSync: _documents.syncKind,
            definitionProvider: true,
            hoverProvider: true,
            completionProvider: {
                triggerCharacters: ['.']
            }
        }
    };
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
_documents.onDidChangeContent(change => {
    let filePath = _convertUriToPath(change.document.uri);
    _connection.console.log(`File "${ filePath }" changed -- marking dirty`);
    _analyzerService.markFilesChanged([filePath]);
    updateOptionsAndRestartService();
});

_connection.onDidChangeConfiguration(change => {
    _connection.console.log(`Received updated settings`);
    updateOptionsAndRestartService(change.settings);
});

_connection.onDefinition(params => {
    let filePath = _convertUriToPath(params.textDocument.uri);

    let position: DiagnosticTextPosition = {
        line: params.position.line,
        column: params.position.character
    };

    let locations = _analyzerService.getDefinitionForPosition(filePath, position);
    if (!locations) {
        return undefined;
    }
    return locations.map(loc =>
        Location.create(_convertPathToUri(loc.path), _convertRange(loc.range)));
});

_connection.onHover(params => {
    let filePath = _convertUriToPath(params.textDocument.uri);

    let position: DiagnosticTextPosition = {
        line: params.position.line,
        column: params.position.character
    };

    let hoverMarkdown = _analyzerService.getHoverForPosition(filePath, position);
    if (!hoverMarkdown) {
        return undefined;
    }
    let markupContent: MarkupContent = {
        kind: 'markdown',
        value: hoverMarkdown
    };
    return { contents: markupContent };
});

_connection.onCompletion(params => {
    let filePath = _convertUriToPath(params.textDocument.uri);

    let position: DiagnosticTextPosition = {
        line: params.position.line,
        column: params.position.character
    };

    return _analyzerService.getCompletionsForPosition(filePath, position);
});

function updateOptionsAndRestartService(settings?: Settings) {
    let commandLineOptions = new CommandLineOptions(_rootPath, true);
    commandLineOptions.watch = true;
    commandLineOptions.verboseOutput = true;

    if (settings && settings.python) {
        if (settings.python.venvPath) {
            commandLineOptions.venvPath = combinePaths(_rootPath,
                normalizePath(_expandPathVariables(settings.python.venvPath)));
        }

        if (settings.python.pythonPath) {
            commandLineOptions.pythonPath = combinePaths(_rootPath,
                normalizePath(_expandPathVariables(settings.python.pythonPath)));
        }

        if (settings.python.analysis &&
                settings.python.analysis.typeshedPaths &&
                settings.python.analysis.typeshedPaths.length > 0) {

            // Pyright supports only one typeshed path currently, whereas the
            // official VS Code Python extension supports multiple typeshed paths.
            // We'll use the first one specified and ignore the rest.
            commandLineOptions.typeshedPath =
                _expandPathVariables(settings.python.analysis.typeshedPaths[0]);
        }
    }

    _analyzerService.setOptions(commandLineOptions);
}

// Expands certain predefined variables supported within VS Code settings.
// Ideally, VS Code would provide an API for doing this expansion, but
// it doesn't. We'll handle the most common variables here as a convenience.
function _expandPathVariables(value: string): string {
    const regexp = /\$\{(.*?)\}/g;
    return value.replace(regexp, (match: string, name: string) => {
        const trimmedName = name.trim();
        if (trimmedName === 'workspaceFolder') {
            return _rootPath;
        }
        return match;
    });
}

function _convertDiagnostics(diags: AnalyzerDiagnostic[]): Diagnostic[] {
    return diags.map(diag => {
        let severity = diag.category === DiagnosticCategory.Error ?
            DiagnosticSeverity.Error : DiagnosticSeverity.Warning;

        let vsDiag = Diagnostic.create(_convertRange(diag.range), diag.message, severity,
            undefined, 'pyright');

        if (diag.category === DiagnosticCategory.UnusedCode) {
            vsDiag.tags = [DiagnosticTag.Unnecessary];
            vsDiag.severity = DiagnosticSeverity.Hint;
        }

        return vsDiag;
    });
}

function _convertRange(range?: DiagnosticTextRange): Range {
    if (!range) {
        return Range.create(_convertPosition(), _convertPosition());
    }
    return Range.create(_convertPosition(range.start), _convertPosition(range.end));
}

function _convertPosition(position?: DiagnosticTextPosition): Position {
    if (!position) {
        return Position.create(0, 0);
    }
    return Position.create(position.line, position.column);
}

_connection.onDidOpenTextDocument(params => {
    let filePath = _convertUriToPath(params.textDocument.uri);
    _analyzerService.setFileOpened(
        filePath,
        params.textDocument.version,
        params.textDocument.text);
});

_connection.onDidChangeTextDocument(params => {
    let filePath = _convertUriToPath(params.textDocument.uri);
    _analyzerService.updateOpenFileContents(
        filePath,
        params.textDocument.version,
        params.contentChanges[0].text);
});

_connection.onDidCloseTextDocument(params => {
    let filePath = _convertUriToPath(params.textDocument.uri);
    _analyzerService.setFileClosed(filePath);
});

function _convertUriToPath(uriString: string): string {
    const uri = VSCodeUri.parse(uriString);
    let convertedPath = normalizePath(uri.path);

    // If this is a DOS-style path with a drive letter, remove
    // the leading slash.
    if (convertedPath.match(/^\\[a-zA-Z]:\\/)) {
        convertedPath = convertedPath.substr(1);
    }

    return convertedPath;
}

function _convertPathToUri(path: string): string {
    return VSCodeUri.file(path).toString();
}

// Listen on the connection
_connection.listen();
