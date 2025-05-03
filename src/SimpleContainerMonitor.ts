/// <reference types="node" />
import * as http from 'http';
import * as https from 'https';

interface ContainerStats {
    name: string;
    cpuUsage: number;
    memoryUsage: number;
}

interface DockerContainer {
    Id: string;
    Names: string[];
}

class NotionPageUpdater {
    private pageId: string | null = null;
    private notionToken: string;
    private apiUrl: string = 'https://api.notion.com/v1';

    constructor() {
        this.notionToken = process.env.NOTION_TOKEN || '';
        if (!this.notionToken) {
            throw new Error('NOTION_TOKEN environment variable is required');
        }
        this.pageId = process.env.NOTION_PAGE_ID || null;
        if (!this.pageId) {
            throw new Error('NOTION_PAGE_ID environment variable is required and must be set to an existing Notion page ID');
        }
    }

    getPageId(): string {
        if (!this.pageId) {
            throw new Error('Page ID not available');
        }
        return this.pageId;
    }
    
    private async makeNotionRequest(path: string, method: string, data?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.notion.com',
                path: `/v1${path}`,
                method: method,
                headers: {
                    'Authorization': `Bearer ${this.notionToken}`,
                    'Content-Type': 'application/json',
                    'Notion-Version': '2022-06-28'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`Notion API error: ${res.statusCode} - ${JSON.stringify(response)}`));
                        } else {
                            resolve(response);
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            
            if (data) {
                req.write(JSON.stringify(data));
            }
            
            req.end();
        });
    }
    
    private formatContainerStatsAsTable(stats: ContainerStats[]): any {
        return {
            object: 'block',
            type: 'table',
            table: {
                table_width: 3,
                has_column_header: true,
                has_row_header: false,
                children: [
                    {
                        type: 'table_row',
                        table_row: {
                            cells: [
                                [{ type: 'text', text: { content: 'Container' } }],
                                [{ type: 'text', text: { content: 'CPU Usage (%)' } }],
                                [{ type: 'text', text: { content: 'Memory Usage (MB)' } }]
                            ]
                        }
                    },
                    ...stats.map(stat => ({
                        type: 'table_row',
                        table_row: {
                            cells: [
                                [{ type: 'text', text: { content: stat.name } }],
                                [{ type: 'text', text: { content: stat.cpuUsage.toString() } }],
                                [{ type: 'text', text: { content: stat.memoryUsage.toString() } }]
                            ]
                        }
                    }))
                ]
            }
        };
    }

    async updatePage(stats: ContainerStats[]): Promise<void> {
        if (!this.pageId) {
            throw new Error('Page ID not available');
        }
        const timestamp = new Date().toISOString();
        const tableBlock = this.formatContainerStatsAsTable(stats);
        const updateData = {
            children: [
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [
                            {
                                type: 'text',
                                text: {
                                    content: `Container Stats - Updated: ${timestamp}`
                                }
                            }
                        ]
                    }
                },
                tableBlock
            ]
        };
        await this.makeNotionRequest(`/blocks/${this.pageId}/children`, 'PATCH', updateData);
    }
}

class DockerMonitor {
    private socketPath: string = '/var/run/docker.sock';

    private async makeDockerRequest(path: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                socketPath: this.socketPath,
                path: path,
                method: 'GET'
            };

            const req = http.request(options, (res: http.IncomingMessage) => {
                let data = '';
                res.on('data', (chunk: Buffer) => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

    private async getContainers(): Promise<Array<{id: string, name: string}>> {
        const containers: DockerContainer[] = await this.makeDockerRequest('/containers/json');
        return containers.map(container => ({
            id: container.Id,
            name: container.Names[0].replace(/^\//, '')
        }));
    }

    private async getContainerStats(containerId: string): Promise<ContainerStats | null> {
        try {
            const stats = await this.makeDockerRequest(`/containers/${containerId}/stats?stream=false`);
            
            // Calculate CPU usage percentage
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
            const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
            const cpuUsage = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;

            // Calculate memory usage in MB
            const memoryUsage = stats.memory_stats.usage / (1024 * 1024);

            return {
                name: containerId,
                cpuUsage: Number(cpuUsage.toFixed(2)),
                memoryUsage: Number(memoryUsage.toFixed(2))
            };
        } catch (error) {
            console.error(`Error getting stats for container ${containerId}:`, error);
            return null;
        }
    }

    async getAllContainerStats(): Promise<ContainerStats[]> {
        const containers = await this.getContainers();
        const statsPromises = containers.map(container => 
            this.getContainerStats(container.id)
                .then(stats => stats ? { ...stats, name: container.name } : null)
        );
        
        const stats = await Promise.all(statsPromises);
        return stats.filter((stat): stat is ContainerStats => stat !== null);
    }
}


async function main() {
    try {
        const dockerMonitor = new DockerMonitor();
        const pageUpdater = new NotionPageUpdater();

        // Update every minute
        setInterval(async () => {
            try {
                const stats = await dockerMonitor.getAllContainerStats();
                console.log('Container stats:', stats);
                await pageUpdater.updatePage(stats);
                console.log(`Page ${pageUpdater.getPageId()} updated successfully`);
            } catch (error) {
                console.error('Error in monitoring loop:', error);
            }
        }, 60000);

        // Run immediately on start
        const stats = await dockerMonitor.getAllContainerStats();
        await pageUpdater.updatePage(stats);
        console.log(`Initial update completed for page ${pageUpdater.getPageId()}`);
    } catch (error) {
        console.error('Error starting the monitor:', error);
    }
}

// Check for required environment variables
if (!process.env.NOTION_TOKEN) {
    console.error('Missing required environment variable. Please set NOTION_TOKEN');
    process.exit(1);
}

main().catch(console.error); 