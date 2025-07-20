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

interface AppState {
    status: TimelineRecordState;
    error: string | null;
    resultSet: ResultSet | null;
    sdkReady: boolean;
}

interface AppProps {
    checkInterval: number;
}

export class App extends React.Component<AppProps, AppState> {

    private buildClient: BuildRestClient | null = null;
    private project: IProjectInfo | null = null;
    private buildPageData: IBuildPageData | null = null;
    private isMountedFlag: boolean = false;

    constructor(props: AppProps) {
        super(props);
        this.state = {
            sdkReady: false,
            status: TimelineRecordState.Pending,
            error: null,
            resultSet: null
        };
        if (this.props.checkInterval <= 0) {
            this.props.checkInterval = 5000;
        }
    }

    componentDidMount() {
        this.isMountedFlag = true;
        this.initializeSDK();

        // Timeout to detect SDK initialization failure
        setTimeout(() => {
            if (this.isMountedFlag && !this.state.sdkReady) {
                this.setError("Azure DevOps SDK failed to initialise.");
            }
        }, 5000);
    }

    componentWillUnmount() {
        this.isMountedFlag = false;
    }

    private setError(msg: string) {
        if (this.isMountedFlag) {
            this.setState({error: msg});
        }
    }

    private async initializeSDK() {
        try {
            await SDK.init();
            await SDK.ready();

            if (!this.isMountedFlag) return;

            this.setState({sdkReady: true});

            const buildPageService: IBuildPageDataService = await SDK.getService(BuildServiceIds.BuildPageDataService);
            this.buildPageData = await buildPageService.getBuildPageData();

            const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
            this.project = await projectService.getProject();

            this.buildClient = API.getClient(BuildRestClient);

            await this.check();
        } catch (e: any) {
            this.setError(`Azure DevOps SDK initialization error: ${e?.message || e}`);
        }
    }

    private async check() {
        if (!this.buildClient || !this.project || !this.buildPageData) {
            this.setError('Build client or project data not initialized.');
            return;
        }

        try {
            const build = await this.buildClient.getBuild(this.project.id, this.buildPageData.build.id);

            // If build is neither completed nor in progress, retry after interval
            if ((build.status & BuildStatus.Completed) === 0 && (build.status & BuildStatus.InProgress) === 0) {
                if (this.isMountedFlag) {
                    this.setState({status: TimelineRecordState.Pending});
                    setTimeout(() => this.check(), this.props.checkInterval);
                }
                return;
            }

            const timeline = await this.buildClient.getBuildTimeline(this.project.id, build.id);

            let recordId = '';
            let recordState: TimelineRecordState | undefined = undefined;

            for (const record of timeline.records) {
                if (record.type === 'Task' && record.task && record.task.name === 'tfsec') {
                    recordId = record.id;
                    recordState = record.state;
                    break;
                }
            }

            if (!recordId) {
                if (this.isMountedFlag) {
                    setTimeout(() => this.check(), this.props.checkInterval);
                }
                return;
            }

            if (recordState !== TimelineRecordState.Completed) {
                if (this.isMountedFlag) {
                    this.setState({status: recordState || TimelineRecordState.Pending});
                    setTimeout(() => this.check(), this.props.checkInterval);
                }
                return;
            }

            const attachments = await this.buildClient.getAttachments(this.project.id, build.id, 'JSON_RESULT');

            if (!attachments || attachments.length === 0) {
                this.setError('No attachments found: cannot load results. Did tfsec run properly?');
                return;
            }

            const attachment = attachments[0];

            const data = await this.buildClient.getAttachment(this.project.id, build.id, timeline.id, recordId, 'JSON_RESULT', attachment.name);

            const resultSet = this.decodeResultSet(data);

            if (this.isMountedFlag) {
                this.setState({status: TimelineRecordState.Completed, resultSet: resultSet, error: null});
            }
        } catch (e: any) {
            this.setError(`Error fetching build results: ${e?.message || e}`);
        }
    }

    private decodeResultSet(buffer: ArrayBuffer): ResultSet {
        try {
            const decoder = new TextDecoder('utf-8');
            const jsonString = decoder.decode(buffer);
            return JSON.parse(jsonString) as ResultSet;
        } catch (e) {
            this.setError('Failed to parse tfsec results JSON.');
            return {results: []};
        }
    }

    render() {
        if (!this.state.sdkReady) {
            return <Loading status={TimelineRecordState.Pending}/>;
        }

        if (this.state.error) {
            return <Crash message={this.state.error}/>;
        }

        if (this.state.status !== TimelineRecordState.Completed) {
            return <Loading status={this.state.status}/>;
        }

        if (!this.state.resultSet || this.state.resultSet.results.length === 0) {
            return <ResultsTable set={{results: []}} />;
        }

        return <ResultsTable set={this.state.resultSet}/>;
    }
}
