import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';
import * as tool from 'azure-pipelines-tool-lib';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import task = require('azure-pipelines-task-lib/task');

async function run() {
    try {
        task.debug("Starting tfsec Azure DevOps task...");

        // Get the tfsec version input (required)
        const version: string | undefined = task.getInput('version', true);
        if (!version) {
            throw new Error('Input "version" is required but not provided.');
        }
        task.debug(`Requested tfsec version: ${version}`);

        // Determine platform and architecture
        const platform = os.platform() === 'win32' ? 'windows' : os.platform();
        // Map architecture to tfsec naming
        let arch = os.arch();
        switch (arch) {
            case 'x64':
                arch = 'amd64';
                break;
            case 'arm64':
                arch = 'arm64';
                break;
            case 'arm':
                arch = 'arm';
                break;
            case 'ia32':
                arch = '386';
                break;
            default:
                arch = 'amd64'; // default fallback
        }

        const extension = platform === 'windows' ? '.exe' : '';
        const artifact = util.format('tfsec-%s-%s%s', platform, arch, extension);

        // Construct download URL
        const url = util.format('https://github.com/aquasecurity/tfsec/releases/download/%s/%s', version, artifact);
        task.debug(`Download URL: ${url}`);

        // Prepare temporary directory and binary path
        const tmpDir = task.getVariable('Agent.TempDirectory') || os.tmpdir();
        const binName = 'tfsec' + extension;
        const localPath = path.join(tmpDir, binName);

        // Remove existing binary if any
        if (fs.existsSync(localPath)) {
            task.debug(`Removing existing binary at ${localPath}`);
            task.rmRF(localPath);
        }

        // Download tfsec binary
        task.debug('Downloading tfsec binary...');
        const downloadPath = await tool.downloadTool(url, localPath);

        // Set executable permissions if needed
        if (platform !== 'windows') {
            task.debug('Setting executable permissions on tfsec binary...');
            await task.exec('chmod', ['+x', downloadPath]);
        }

        // Prepare output directory for results
        const outputDir = path.join(tmpDir, `tfsec-results-${Date.now()}`);
        if (fs.existsSync(outputDir)) {
            task.rmRF(outputDir);
        }
        fs.mkdirSync(outputDir, { recursive: true });
        task.debug(`Output directory created at ${outputDir}`);

        // Prepare tfsec command runner
        const runner: ToolRunner = task.tool(downloadPath);

        // Get additional args input
        const argsInput = task.getInput('args', false);
        if (argsInput) {
            // Split args safely by spaces respecting quotes
            const argsArray = parseArgs(argsInput);
            runner.arg(argsArray);
        }

        // Add debug flag if requested
        if (task.getBoolInput('debug', false)) {
            runner.arg('--debug');
        }

        // Add output format and output directory
        runner.arg(['-f', 'junit,json']);
        runner.arg(['-O', outputDir]);

        // Directory to scan
        const scanDir = task.getInput('dir', false) || task.cwd();
        if (!fs.existsSync(scanDir) || !fs.statSync(scanDir).isDirectory()) {
            throw new Error(`Scan directory does not exist or is not a directory: ${scanDir}`);
        }
        runner.arg(scanDir);

        // Execute tfsec
        task.debug('Executing tfsec...');
        const execResult = await runner.exec();

        // Determine task result based on tfsec exit code
        if (execResult === 0) {
            task.setResult(task.TaskResult.Succeeded, 'No problems found by tfsec.');
        } else {
            task.setResult(task.TaskResult.Failed, 'tfsec detected misconfigurations.');
        }

        // Publish JUnit test results if requested
        if (task.getBoolInput('publishTestResults', false)) {
            const junitFile = path.join(outputDir, 'results.junit');
            if (fs.existsSync(junitFile)) {
                task.debug(`Publishing JUnit test results from ${junitFile}`);
                const publisher: task.TestPublisher = new task.TestPublisher('JUnit');
                publisher.publish(junitFile, true, '', '', 'tfsec', true, 'tfsec');
            } else {
                task.warning(`JUnit results file not found at expected location: ${junitFile}`);
            }
        }

        // Attach JSON results
        const jsonFile = path.join(outputDir, 'results.json');
        if (fs.existsSync(jsonFile)) {
            task.debug(`Attaching JSON results from ${jsonFile}`);
            task.addAttachment('JSON_RESULT', 'results.json', jsonFile);
        } else {
            task.warning(`JSON results file not found at expected location: ${jsonFile}`);
        }

        // Cleanup output directory
        task.debug('Cleaning up output directory...');
        task.rmRF(outputDir);

        task.debug('tfsec task completed successfully.');
    } catch (err: any) {
        task.error(err);
        task.setResult(task.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

/**
 * Parse command line arguments string into array safely.
 * Handles quoted strings and escapes.
 * @param input string
 * @returns string[]
 */
function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let escape = false;

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (escape) {
            current += char;
            escape = false;
        } else if (char === '\\') {
            escape = true;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ' ' && !inQuotes) {
            if (current.length > 0) {
                args.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current.length > 0) {
        args.push(current);
    }
    return args;
}

run();
