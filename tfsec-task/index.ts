import * as os from 'os';
import * as util from 'util';
import * as path from 'path';
import * as crypto from 'crypto';
import * as tool from 'azure-pipelines-tool-lib';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import task = require('azure-pipelines-task-lib/task');

// Regex to validate semantic versioning (basic)
const semverRegex = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w\.]+)?$/;

// Sanitize args to allow only safe characters (alphanumeric, spaces, dashes, underscores, dots, equals)
const safeArgsRegex = /^[\w\s\-_=\.]*$/;

async function run() {
    let outputPath = '';
    try {
        console.log("Starting tfsec Azure Pipelines task...");

        // Validate version input
        let version: string | undefined = task.getInput('version', true);
        if (!version || !semverRegex.test(version)) {
            throw new Error(`Invalid tfsec version input: '${version}'. Expected semantic versioning format like 'v1.26.0'.`);
        }
        console.log(`Using tfsec version: ${version}`);

        // Determine platform-specific paths
        let tmpDir = os.tmpdir();
        let binName = 'tfsec';
        let chmodRequired = true;
        if (os.platform() === 'win32') {
            binName = 'tfsec.exe';
            chmodRequired = false;
        }
        const localPath = path.join(tmpDir, binName);

        // Remove any existing binary
        task.rmRF(localPath);

        // Get download URL
        const url = await getArtifactURL(version);
        console.log(`Downloading tfsec from: ${url}`);

        // Download tfsec binary
        const downloadPath = await tool.downloadTool(url, localPath);

        // Set executable permissions if needed
        if (chmodRequired) {
            await task.exec('chmod', ['+x', downloadPath]);
        }

        // Prepare output directory with secure random suffix
        const randomSuffix = crypto.randomBytes(8).toString('hex');
        outputPath = path.join(tmpDir, `tfsec-results-${randomSuffix}`);
        task.rmRF(outputPath);

        // Configure tfsec runner
        const runner: ToolRunner = task.tool(downloadPath);

        // Validate and add extra args
        const args = task.getInput('args', false);
        if (args !== undefined && args.trim() !== '') {
            if (!safeArgsRegex.test(args)) {
                throw new Error('Invalid characters detected in args input. Only alphanumeric, spaces, dashes, underscores, dots, and equals are allowed.');
            }
            runner.line(args);
        }

        // Add debug flag if enabled
        if (task.getBoolInput('debug', false)) {
            runner.arg('--debug');
        }

        // Output formats
        runner.arg(['-f', 'junit,json']);
        runner.arg(['-O', outputPath]);

        // Directory to scan
        const dir = task.getInput('dir', false);
        if (dir !== undefined && dir.trim() !== '') {
            runner.arg(dir);
        } else {
            runner.arg(task.cwd());
        }

        console.log('Running tfsec scan...');

        // Execute with timeout (e.g., 5 minutes)
        const execPromise = runner.exec();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('tfsec execution timed out after 5 minutes')), 5 * 60 * 1000));

        const resultCode = await Promise.race([execPromise, timeoutPromise]);

        if (resultCode === 0) {
            task.setResult(task.TaskResult.Succeeded, 'No problems found.');
        } else {
            task.setResult(task.TaskResult.Failed, 'tfsec detected misconfigurations.');
        }

        // Publish test results if enabled
        if (task.getBoolInput('publishTestResults', false)) {
            const junitFile = path.join(outputPath, 'results.junit');
            if (task.exist(junitFile)) {
                console.log('Publishing JUnit test results...');
                const publisher: task.TestPublisher = new task.TestPublisher('JUnit');
                publisher.publish(junitFile, true, '', '', 'tfsec', true, 'tfsec');
            } else {
                console.warn(`JUnit results file not found at ${junitFile}, skipping publishing test results.`);
            }
        }

        // Publish JSON results attachment
        const jsonFile = path.join(outputPath, 'results.json');
        if (task.exist(jsonFile)) {
            console.log('Publishing JSON results attachment...');
            task.addAttachment('JSON_RESULT', 'results.json', jsonFile);
        } else {
            console.warn(`JSON results file not found at ${jsonFile}, skipping attachment.`);
        }

        console.log('Cleaning up temporary files...');
        task.rmRF(outputPath);

        console.log('tfsec task completed successfully.');
    } catch (err: any) {
        console.error('Error running tfsec task:', err);
        task.setResult(task.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

async function getArtifactURL(version: string): Promise<string> {
    // Determine platform and architecture
    const platform = os.platform() === 'win32' ? 'windows' : os.platform();
    const arch = os.arch() === 'x64' ? 'amd64' : '386';
    const extension = os.platform() === 'win32' ? '.exe' : '';
    const artifact = util.format('tfsec-%s-%s%s', platform, arch, extension);

    // Construct download URL
    const url = util.format('https://github.com/aquasecurity/tfsec/releases/download/%s/%s', version, artifact);
    return url;
}

run();
