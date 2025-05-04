#!/usr/bin/env node

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
    private static lastNotionRequestTime: number = 0;
    private static notionRequestQueue: Promise<any> = Promise.resolve();
    private lastBlockId: string | null = null;

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

    // List first page of blocks and delete any quote parent with the marker in its children
    async cleanupOldBlocksWithMarker(): Promise<void> {
        if (!this.pageId) return;
        // List first page of children
        const childrenResp = await this.makeNotionRequest(`/blocks/${this.pageId}/children?page_size=100`, 'GET');
        if (!childrenResp || !childrenResp.results) return;
        const blocks = childrenResp.results;
        for (const block of blocks) {
            if (block.type === 'quote' && block.has_children) {
                // Fetch children of the quote block
                const quoteChildrenResp = await this.makeNotionRequest(`/blocks/${block.id}/children?page_size=20`, 'GET');
                if (!quoteChildrenResp || !quoteChildrenResp.results) continue;
                const hasMarker = quoteChildrenResp.results.some((child: any) =>
                    child.type === 'paragraph' &&
                    child.paragraph &&
                    child.paragraph.rich_text &&
                    child.paragraph.rich_text.some((rt: any) => rt.text && rt.text.content && rt.text.content.includes('Managed by simple-container-monitor'))
                );
                if (hasMarker) {
                    // Delete the entire quote block (and all its children)
                    await this.makeNotionRequest(`/blocks/${block.id}`, 'DELETE');
                }
            }
        }
    }

    getPageId(): string {
        if (!this.pageId) {
            throw new Error('Page ID not available');
        }
        return this.pageId;
    }
    
    private async makeNotionRequest(path: string, method: string, data?: any): Promise<any> {
        // Notion API: 3 requests/sec per integration (so 350ms between requests is safe)
        const MIN_INTERVAL = 350; // ms
        const now = Date.now();
        const wait = Math.max(0, NotionPageUpdater.lastNotionRequestTime + MIN_INTERVAL - now);

        // Chain requests to ensure order and rate limit
        NotionPageUpdater.notionRequestQueue = NotionPageUpdater.notionRequestQueue.then(() =>
            new Promise<void>(resolve => setTimeout(resolve, wait))
        );
        await NotionPageUpdater.notionRequestQueue;
        NotionPageUpdater.lastNotionRequestTime = Date.now();

        const makeRequest = (): Promise<any> => {
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
                            if (res.statusCode && res.statusCode === 429) {
                                // Rate limited, retry after delay
                                const retryAfter = parseInt(res.headers['retry-after'] as string, 10) || 1;
                                setTimeout(() => {
                                    makeRequest().then(resolve).catch(reject);
                                }, retryAfter * 1000);
                                return;
                            } else if (res.statusCode && res.statusCode >= 400) {
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
        };

        return makeRequest();
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
                                [{ type: 'text', text: { content: 'CPU (%)' } }],
                                [{ type: 'text', text: { content: 'RAM (MB)' } }]
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
        // Delete the last block we created (if any)
        if (this.lastBlockId) {
            try {
                await this.makeNotionRequest(`/blocks/${this.lastBlockId}`, 'DELETE');
            } catch (e) {
                // Ignore errors (block may have been deleted manually)
            }
            this.lastBlockId = null;
        }
        // Format timestamp without milliseconds, keep timezone
        const timestamp = new Date().toISOString().split('.')[0] + 'Z';
        const tableBlock = this.formatContainerStatsAsTable(stats);
        // Compose the update as children of a quote block
        const quoteBlock = {
            object: 'block',
            type: 'quote',
            quote: {
                rich_text: [
                    {
                        type: 'text',
                        text: {
                            content: 'Container Stats',
                        },
                        annotations: {
                            bold: true
                        }
                    }
                ],
                children: [
                    {
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [
                                {
                                    type: 'text',
                                    text: {
                                        content: `Updated: ${timestamp}`
                                    }
                                }
                            ]
                        }
                    },
                    tableBlock,
                    {
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [
                                {
                                    type: 'text',
                                    text: {
                                        content: 'Managed by simple-container-monitor'
                                    },
                                    annotations: {
                                        color: 'gray',
                                        bold: false,
                                        italic: true
                                    }
                                }
                            ]
                        }
                    }
                ]
            }
        };
        // Add the quote block to the page
        const updateData = { children: [quoteBlock] };
        const resp = await this.makeNotionRequest(`/blocks/${this.pageId}/children`, 'PATCH', updateData);
        // Remember the last block we created (the quote block)
        if (resp && resp.results && Array.isArray(resp.results) && resp.results.length > 0) {
            const last = resp.results[resp.results.length - 1];
            this.lastBlockId = last.id;
        }
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

        // On startup, clean up any old blocks with the marker
        await pageUpdater.cleanupOldBlocksWithMarker();

        // Update every minute
        setInterval(async () => {
            try {
                const stats = await dockerMonitor.getAllContainerStats();
                await pageUpdater.updatePage(stats);
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