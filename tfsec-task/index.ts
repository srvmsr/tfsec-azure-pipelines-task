import * as os from 'os';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as tool from 'azure-pipelines-tool-lib';
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import task = require('azure-pipelines-task-lib/task');

async function run() {
    let outputPath = '';
    try {
        console.log("Starting tfsec Azure DevOps task...");

        // Validate and get version input
        let version: string | undefined = task.getInput('version', true);
        if (!version || !/^v?\d+\.\d+\.\d+(-[\w\d.-]+)?$/.test(version)) {
            throw new Error(`Invalid version format: '${version}'. Expected semantic versioning like 'v1.26.0'.`);
        }
        if (!version.startsWith('v')) {
            version = 'v' + version;
        }
        console.log(`Using tfsec version: ${version}`);

        // Determine platform specifics
        const platform = os.platform();
        const arch = os.arch();
        let tmpPath = '';
        let binName = 'tfsec';
        let chmodRequired = true;

        if (platform === 'win32') {
            tmpPath = path.join(process.env['USERPROFILE'] || '', 'AppData', 'Local', 'Temp');
            binName = 'tfsec.exe';
            chmodRequired = false;
        } else {
            tmpPath = '/tmp';
        }

        const localPath = path.join(tmpPath, binName);

        // Clean up any existing binary
        if (fs.existsSync(localPath)) {
            task.rmRF(localPath);
        }

        // Get download URL
        const url = await getArtifactURL(version, platform, arch, binName);
        console.log(`Downloading tfsec from: ${url}`);

        // Download tfsec binary
        const downloadPath = await tool.downloadTool(url, localPath);

        if (!fs.existsSync(downloadPath)) {
            throw new Error(`Downloaded file does not exist at expected path: ${downloadPath}`);
        }

        // Set executable permissions if needed
        if (chmodRequired) {
            await task.exec('chmod', ['+x', downloadPath]);
        }

        // Prepare output directory
        outputPath = path.join(tmpPath, `tfsec-results-${Date.now()}`);
        if (fs.existsSync(outputPath)) {
            task.rmRF(outputPath);
        }

        // Configure tfsec runner
        const runner: ToolRunner = task.tool(downloadPath);

        // Add extra args if provided
        const args = task.getInput('args', false);
        if (args && args.trim().length > 0) {
            runner.line(args);
        }

        // Add debug flag if enabled
        if (task.getBoolInput('debug', false)) {
            runner.arg('--debug');
        }

        // Output formats and output directory
        runner.arg(['-f', 'junit,json']);
        runner.arg(['-O', outputPath]);

        // Directory to scan
        const dir = task.getInput('dir', false);
        if (dir && dir.trim().length > 0) {
            runner.arg(dir);
        } else {
            runner.arg(task.cwd());
        }

        console.log('Executing tfsec scan...');
        const result = runner.execSync();

        // Check result code
        if (result.code === 0) {
            task.setResult(task.TaskResult.Succeeded, 'No problems found.');
        } else {
            task.setResult(task.TaskResult.Failed, 'tfsec detected misconfigurations.');
        }

        // Publish test results if enabled
        if (task.getBoolInput('publishTestResults', false)) {
            const junitFile = path.join(outputPath, 'results.junit');
            if (fs.existsSync(junitFile)) {
                console.log('Publishing JUnit test results...');
                const publisher: task.TestPublisher = new task.TestPublisher('JUnit');
                publisher.publish(junitFile, true, '', '', 'tfsec', true, 'tfsec');
            } else {
                console.warn(`JUnit results file not found at ${junitFile}, skipping publish.`);
            }
        }

        // Publish JSON results attachment
        const jsonFile = path.join(outputPath, 'results.json');
        if (fs.existsSync(jsonFile)) {
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
    } finally {
        // Ensure cleanup of temp files if outputPath was created
        if (outputPath && fs.existsSync(outputPath)) {
            try {
                task.rmRF(outputPath);
            } catch (cleanupErr) {
                console.warn('Failed to clean up temporary output directory:', cleanupErr);
            }
        }
    }
}

async function getArtifactURL(version: string, platform: string, arch: string, binName: string): Promise<string> {
    // Map platform
    let platformName = '';
    switch (platform) {
        case 'win32':
            platformName = 'windows';
            break;
        case 'darwin':
            platformName = 'darwin';
            break;
        case 'linux':
            platformName = 'linux';
            break;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }

    // Map architecture
    let archName = '';
    switch (arch) {
        case 'x64':
            archName = 'amd64';
            break;
        case 'arm64':
            archName = 'arm64';
            break;
        case 'arm':
            archName = 'arm';
            break;
        case 'ia32':
            archName = '386';
            break;
        default:
            throw new Error(`Unsupported architecture: ${arch}`);
    }

    const extension = platform === 'win32' ? '.exe' : '';
    const artifact = util.format('tfsec-%s-%s%s', platformName, archName, extension);
    const url = util.format('https://github.com/aquasecurity/tfsec/releases/download/%s/%s', version, artifact);
    return url;
}

run();
