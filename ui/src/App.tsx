import * as React from 'react';
import {
    BuildRestClient,
    BuildServiceIds,
    BuildStatus,
    IBuildPageData,
    IBuildPageDataService
} from "azure-devops-extension-api/Build";
import * as SDK from "azure-devops-extension-sdk";
import * as API from "azure-devops-extension-api";
import {CommonServiceIds, IProjectInfo, IProjectPageService} from "azure-devops-extension-api";
import {TimelineRecord, TimelineRecordState} from "azure-devops-extension-api/Build/Build";
import {ResultSet} from './tfsec'
import {Loading} from './Loading'
import {ResultsTable} from './ResultsTable'
import {Crash} from './Crash'

type AppState = {
    status: TimelineRecordState
    error: string
    resultSet: ResultSet
    sdkReady: boolean
}

interface AppProps {
    checkInterval: number
}

export class App extends React.Component<AppProps, AppState> {

    private buildClient!: BuildRestClient;
    private project!: IProjectInfo;
    private buildPageData!: IBuildPageData;
    private timeoutId?: NodeJS.Timeout;
    public props: AppProps;

    constructor(props: AppProps) {
        super(props)
        if(props.checkInterval === 0) {
            props.checkInterval = 5000
        }
        this.props = props
        this.state = {
            sdkReady: false,
            status: TimelineRecordState.Pending,
            error: "",
            resultSet: {
                results: []
            }
        }
    }

    componentWillUnmount(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }
    }

    async check(): Promise<void> {
        try {
            const build = await this.buildClient.getBuild(this.project.id, this.buildPageData.build.id)
            // if the build isn't running/finished, try again shortly
            if ((build.status & BuildStatus.Completed) === 0 && (build.status & BuildStatus.InProgress) === 0) {
                this.setState({status: TimelineRecordState.Pending})
                this.timeoutId = setTimeout(this.check.bind(this), this.props.checkInterval)
                return
            }
            const timeline = await this.buildClient.getBuildTimeline(this.project.id, build.id)
            let recordId = ""
            let recordState: TimelineRecordState | undefined;
            if (timeline && timeline.records) {
                timeline.records.forEach(function (record: TimelineRecord) {
                    if (record.type === "Task" && record.task !== null && record.task.name === "tfsec") {
                        recordId = record.id
                        recordState = record.state
                    }
                })
            }
            if (recordId === "") {
                this.timeoutId = setTimeout(this.check.bind(this), this.props.checkInterval)
                return
            }
            if (recordState !== TimelineRecordState.Completed) {
                this.setState({status: recordState || TimelineRecordState.Pending})
                this.timeoutId = setTimeout(this.check.bind(this), this.props.checkInterval)
                return
            }
            const attachments = await this.buildClient.getAttachments(this.project.id, build.id, "JSON_RESULT")
            if (attachments.length === 0) {
                this.setState({error: "No attachments found: cannot load results. Did tfsec run properly?"})
                return
            }
            const attachment = attachments[0];
            const data = await this.buildClient.getAttachment(this.project.id, build.id, timeline.id, recordId, "JSON_RESULT", attachment.name)
            const resultSet = this.decodeResultSet(data)
            this.setState({status: recordState, resultSet: resultSet})
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.setError(`Failed to check build status: ${errorMessage}`);
        }
    }

    setError(msg: string): void {
        this.setState({error: msg})
    }

    async componentDidMount(): Promise<void> {
        const sdkTimeoutId = setTimeout(() => {
            if (!this.state.sdkReady) {
                this.setError("Azure DevOps SDK failed to initialise.")
            }
        }, 5000);

        try {
            await SDK.init();
            await SDK.ready();
            clearTimeout(sdkTimeoutId);
            this.setState({sdkReady: true})
            const buildPageService: IBuildPageDataService = await SDK.getService(BuildServiceIds.BuildPageDataService);
            this.buildPageData = await buildPageService.getBuildPageData();
            const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
            this.project = await projectService.getProject();
            this.buildClient = API.getClient(BuildRestClient)
            await this.check()
        } catch (error) {
            clearTimeout(sdkTimeoutId);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.setError(`Azure DevOps SDK initialization failed: ${errorMessage}`);
        }
    }

    decodeResultSet(buffer: ArrayBuffer): ResultSet {
        let output = '';
        const arr = new Uint8Array(buffer);
        const len = arr.byteLength;
        for (let i = 0; i < len; i++) {
            output += String.fromCharCode(arr[i]);
        }
        try {
            return JSON.parse(output);
        } catch (error) {
            throw new Error('Failed to parse results JSON: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    // render will know everything!
    render(): JSX.Element {
        return (
            this.state.status === TimelineRecordState.Completed ?
                <ResultsTable set={this.state.resultSet}/>
                :
                (this.state.error !== "" ?
                        <Crash message={this.state.error}/>
                        :
                        <Loading status={this.state.status}/>
                )
        )
    }
}
