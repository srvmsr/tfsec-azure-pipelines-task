import * as os from 'os';
import * as util from 'util';
import * as tool from 'azure-pipelines-tool-lib';
import {ToolRunner} from 'azure-pipelines-task-lib/toolrunner';
import task = require('azure-pipelines-task-lib/task');

async function run() {
    try {
        console.log("Finding correct tfsec version...");
        let url = await getArtifactURL();

        let tmpPath = "/tmp/";
        let bin = "tfsec";
        let chmodRequired = true;

        if (os.platform() === "win32") {
            const userProfile = process.env["USERPROFILE"];
            if (!userProfile) {
                throw new Error("USERPROFILE environment variable is not set on Windows platform.");
            }
            tmpPath = userProfile + "\\AppData\\Local\\Temp\\";
            bin = "tfsec.exe";
            chmodRequired = false;
        }

        let localPath = tmpPath + bin;
        task.rmRF(localPath);

        console.log("Downloading tfsec from " + url);
        let downloadPath = await tool.downloadTool(url, localPath);

        if (chmodRequired) {
            await task.exec('chmod', ["+x", downloadPath]);
        }

        console.log("Preparing output location...");
        let outputPath = tmpPath + "tfsec-results-" + Math.random().toString(36).substring(2, 15);
        task.rmRF(outputPath);

        console.log("Configuring options...");
        let runner: ToolRunner = task.tool(downloadPath);

        let args = task.getInput("args", false);
        if (args && args.trim().length > 0) {
            // Split args by spaces respecting quoted strings
            const parsedArgs = parseArgsStringToArgv(args);
            runner.arg(parsedArgs);
        }

        if (task.getBoolInput("debug", false)) {
            runner.arg("--debug");
        }

        runner.arg(["-f", "junit,json"]);
        runner.arg(["-O", outputPath]);

        let dir = task.getInput("dir", false);
        if (dir && dir.trim().length > 0) {
            runner.arg(dir);
        } else {
            runner.arg(task.cwd());
        }

        console.log("Running tfsec...");
        let result = runner.execSync();

        if (result.code === 0) {
            task.setResult(task.TaskResult.Succeeded, "No problems found.");
        } else {
            task.setResult(task.TaskResult.Failed, "Failed: tfsec detected misconfigurations.");
        }

        if (task.getBoolInput("publishTestResults", false)) {
            console.log("Publishing JUnit results...");
            const publisher: task.TestPublisher = new task.TestPublisher('JUnit');
            // Validate that the junit file exists before publishing
            const junitFile = outputPath + ".junit";
            if (task.exist(junitFile)) {
                publisher.publish(junitFile, 'true', '', '', "tfsec", 'true', "tfsec");
            } else {
                console.warn(`JUnit results file not found at ${junitFile}, skipping publishing.`);
            }
        }

        console.log("Publishing JSON results...");
        const jsonFile = outputPath + ".json";
        if (task.exist(jsonFile)) {
            task.addAttachment("JSON_RESULT", "results.json", jsonFile);
        } else {
            console.warn(`JSON results file not found at ${jsonFile}, skipping attachment.`);
        }

        console.log("Tidying up...");
        task.rmRF(outputPath);

        console.log("Done!");
    } catch (err: any) {
        task.setResult(task.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

async function getArtifactURL(): Promise<string> {
    let version: string | undefined = task.getInput('version', false);
    if (!version || version.trim() === '') {
        version = 'v1.26.0'; // default version
    }
    version = version.trim();

    console.log("Required tfsec version is " + version);

    let platformRaw = os.platform();
    let platform: string;
    switch(platformRaw) {
        case 'win32':
            platform = 'windows';
            break;
        case 'darwin':
            platform = 'darwin';
            break;
        case 'linux':
            platform = 'linux';
            break;
        default:
            throw new Error(`Unsupported platform: ${platformRaw}`);
    }

    let archRaw = os.arch();
    let arch: string;
    switch(archRaw) {
        case 'x64':
            arch = 'amd64';
            break;
        case 'arm64':
            arch = 'arm64';
            break;
        case 'ia32':
            arch = '386';
            break;
        default:
            throw new Error(`Unsupported architecture: ${archRaw}`);
    }

    let extension: string = platform === 'windows' ? '.exe' : '';
    let artifact: string = util.format("tfsec-%s-%s%s", platform, arch, extension);

    const url = util.format("https://github.com/aquasecurity/tfsec/releases/download/%s/%s", version, artifact);

    return url;
}

/**
 * Parses a command line string into arguments array, respecting quoted strings.
 * This is a simple implementation to avoid shell injection risks.
 */
function parseArgsStringToArgv(value: string): string[] {
    const regex = /(?:["']([^"']*)["'])|([^\s]+)/g;
    const args: string[] = [];
    let match;
    while ((match = regex.exec(value)) !== null) {
        if (match[1]) {
            args.push(match[1]);
        } else if (match[2]) {
            args.push(match[2]);
        }
    }
    return args;
}

run();