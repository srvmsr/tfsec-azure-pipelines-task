import * as os from 'os';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as tool from 'azure-pipelines-tool-lib';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import task = require('azure-pipelines-task-lib/task');

async function run() {
    try {
        task.debug('Starting tfsec Azure DevOps task');

        // Get the tfsec version input, validate or use default
        let version: string | undefined = task.getInput('version', false);
        if (!version || version.trim() === '') {
            version = 'v1.26.0';
            task.debug(`No version specified, defaulting to ${version}`);
        } else {
            version = version.trim();
            if (!/^v?\d+\.\d+\.\d+/.test(version)) {
                throw new Error(`Invalid version format: ${version}. Expected format like v1.26.0`);
            }
            if (!version.startsWith('v')) {
                version = 'v' + version;
            }
            task.debug(`Using specified tfsec version: ${version}`);
        }

        // Determine platform and architecture
        const platform = (() => {
            const p = os.platform();
            if (p === 'win32') return 'windows';
            if (p === 'darwin') return 'darwin';
            if (p === 'linux') return 'linux';
            throw new Error(`Unsupported platform: ${p}`);
        })();

        const arch = (() => {
            const a = os.arch();
            if (a === 'x64') return 'amd64';
            if (a === 'arm64') return 'arm64';
            if (a === 'arm') return 'arm';
            if (a === 'ia32') return '386';
            throw new Error(`Unsupported architecture: ${a}`);
        })();

        const extension = platform === 'windows' ? '.exe' : '';
        const artifactName = `tfsec-${platform}-${arch}${extension}`;

        // Construct download URL
        const url = `https://github.com/aquasecurity/tfsec/releases/download/${version}/${artifactName}`;
        task.debug(`Downloading tfsec from URL: ${url}`);

        // Prepare temporary directory and binary path
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tfsec-'));
        const binPath = path.join(tmpDir, `tfsec${extension}`);

        // Clean up any existing file (unlikely due to mkdtemp, but safe)
        if (fs.existsSync(binPath)) {
            task.rmRF(binPath);
        }

        // Download tfsec binary
        const downloadPath = await tool.downloadTool(url, binPath);
        task.debug(`Downloaded tfsec to ${downloadPath}`);

        // Set executable permissions if needed
        if (platform !== 'windows') {
            await task.exec('chmod', ['+x', downloadPath]);
            task.debug('Set executable permissions on tfsec binary');
        }

        // Prepare output directory for results
        const outputDir = path.join(tmpDir, 'tfsec-results');
        if (fs.existsSync(outputDir)) {
            task.rmRF(outputDir);
        }
        await fs.promises.mkdir(outputDir, { recursive: true });

        // Configure tfsec command runner
        const runner: ToolRunner = task.tool(downloadPath);

        // Add user-supplied args if any
        const argsInput = task.getInput('args', false);
        if (argsInput && argsInput.trim() !== '') {
            // Split args respecting quoted strings
            const argsArray = parseArgs(argsInput);
            runner.arg(argsArray);
            task.debug(`Added user args: ${argsArray.join(' ')}`);
        }

        // Add debug flag if enabled
        if (task.getBoolInput('debug', false)) {
            runner.arg('--debug');
            task.debug('Debug mode enabled');
        }

        // Force output formats and output directory
        runner.arg(['-f', 'junit,json']);
        runner.arg(['-O', outputDir]);

        // Directory to scan
        const scanDir = task.getInput('dir', false);
        if (scanDir && scanDir.trim() !== '') {
            runner.arg(scanDir.trim());
            task.debug(`Scanning directory: ${scanDir.trim()}`);
        } else {
            runner.arg(task.cwd());
            task.debug(`Scanning current working directory: ${task.cwd()}`);
        }

        // Execute tfsec with timeout (e.g., 5 minutes)
        const execOptions = { failOnStdErr: false, ignoreReturnCode: true, silent: false, timeout: 300000 };
        task.debug('Running tfsec scan...');
        const result = await runner.exec(execOptions);
        task.debug(`tfsec exited with code ${result}`);

        // Determine task result based on exit code
        // tfsec returns 0 if no issues, 1 if issues found, >1 for errors
        if (result === 0) {
            task.setResult(task.TaskResult.Succeeded, 'No problems found.');
        } else if (result === 1) {
            task.setResult(task.TaskResult.Failed, 'tfsec detected misconfigurations.');
        } else {
            task.setResult(task.TaskResult.Failed, `tfsec execution failed with exit code ${result}.`);
        }

        // Publish test results if enabled
        if (task.getBoolInput('publishTestResults', false)) {
            try {
                const publisher: task.TestPublisher = new task.TestPublisher('JUnit');
                const junitPath = path.join(outputDir, 'tfsec.junit');
                if (fs.existsSync(junitPath)) {
                    publisher.publish(junitPath, true, '', '', 'tfsec', true, 'tfsec');
                    task.debug('Published JUnit test results');
                } else {
                    task.warning('JUnit test results file not found, skipping publishing.');
                }
            } catch (pubErr) {
                task.warning(`Failed to publish test results: ${pubErr}`);
            }
        }

        // Publish JSON results as attachment
        try {
            const jsonPath = path.join(outputDir, 'tfsec.json');
            if (fs.existsSync(jsonPath)) {
                task.addAttachment('JSON_RESULT', 'results.json', jsonPath);
                task.debug('Published JSON results as attachment');
            } else {
                task.warning('JSON results file not found, skipping attachment publishing.');
            }
        } catch (attachErr) {
            task.warning(`Failed to publish JSON attachment: ${attachErr}`);
        }

        // Cleanup temporary directory
        try {
            task.rmRF(tmpDir);
            task.debug(`Cleaned up temporary directory ${tmpDir}`);
        } catch (cleanupErr) {
            task.warning(`Failed to clean up temporary directory: ${cleanupErr}`);
        }

        task.debug('tfsec Azure DevOps task completed');
    } catch (err: any) {
        task.setResult(task.TaskResult.Failed, `Task failed with error: ${err.message}`);
        task.debug(`Error stack: ${err.stack}`);
    }
}

/**
 * Parses a command line string into arguments array respecting quotes.
 * @param input string
 * @returns string[]
 */
function parseArgs(input: string): string[] {
    const regex = /(?:["']([^"']+)["'])|([^\s]+)/g;
    const args: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
        if (match[1]) {
            args.push(match[1]);
        } else if (match[2]) {
            args.push(match[2]);
        }
    }
    return args;
}

run();