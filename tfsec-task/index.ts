import * as os from 'os';
import * as util from 'util';
import * as tool from 'azure-pipelines-tool-lib';
import {ToolRunner} from 'azure-pipelines-task-lib/toolrunner';
import task = require('azure-pipelines-task-lib/task');

async function run(): Promise<void> {
    try {
        console.log("Finding correct tfsec version...")
        const url = await getArtifactURL()
        let tmpPath = "/tmp/"
        let bin = "tfsec"
        let chmodRequired = true;
        if (os.platform() == "win32") {
            tmpPath = process.env["USERPROFILE"] + "\\AppData\\Local\\Temp\\"
            bin = "tfsec.exe"
            chmodRequired = false;
        }
        const localPath = tmpPath + bin;
        task.rmRF(localPath);

        console.log("Downloading tfsec...")
        const downloadPath = await tool.downloadTool(url, localPath);
        if (chmodRequired) {
            await task.exec('chmod', ["+x", downloadPath]);
        }

        console.log("Preparing output location...")
        const outputPath = tmpPath + "tfsec-results-" + Math.random();
        task.rmRF(outputPath);

        console.log("Configuring options...")
        const runner: ToolRunner = task.tool(downloadPath);
        const args = task.getInput("args", false)
        if (args !== undefined && args !== null) {
            runner.line(args)
        }
        if (task.getBoolInput("debug", false)) {
            runner.arg("--debug")
        }
        runner.arg(["-f", "junit,json"]);
        runner.arg(["-O", outputPath]);
        const dir = task.getInput("dir", false)
        if (dir !== undefined && dir !== null) {
            runner.arg(dir)
        } else {
            runner.arg(task.cwd());
        }

        console.log("Running tfsec...")
        const result = runner.execSync();
        if (result.code === 0) {
            task.setResult(task.TaskResult.Succeeded, "No problems found.")
        } else {
            task.setResult(task.TaskResult.Failed, "Failed: tfsec detected misconfigurations.")
        }

        if (task.getBoolInput("publishTestResults", false)) {
            console.log("Publishing JUnit results...")
            const publisher: task.TestPublisher = new task.TestPublisher('JUnit');
            publisher.publish(outputPath + ".junit", 'true', '', '', "tfsec", 'true', "tfsec");
        }

        console.log("Publishing JSON results...")
        task.addAttachment("JSON_RESULT", "results.json", outputPath + ".json")

        console.log("Tidying up...")
        task.rmRF(outputPath);

        console.log("Done!");
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        task.setResult(task.TaskResult.Failed, errorMessage);
    }
}

async function getArtifactURL(): Promise<string> {
    const version: string | undefined = task.getInput('version', true);
    if (!version) {
        throw new Error('Version input is required');
    }
    console.log("Required tfsec version is " + version)
    const platform: string = os.platform() == "win32" ? "windows" : os.platform();
    const arch: string = os.arch() == "x64" ? "amd64" : "386";
    const extension: string = os.platform() == "win32" ? ".exe" : "";
    const artifact: string = util.format("tfsec-%s-%s%s", platform, arch, extension);
    return util.format("https://github.com/aquasecurity/tfsec/releases/download/%s/%s", version, artifact);
}

run();