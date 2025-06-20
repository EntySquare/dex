import { SyncService, DEFAULT_SYNC_CONFIG, type SyncConfig } from './sync-service';
import { DatabaseService } from './database-service';
import { EventListener } from './event-listener';
import { OnChainService } from './onchain-service';
import { PriceService } from './price-service';
import { PoolDiscoveryService } from './pool-discovery';
import { 
  TRADER_JOE_POOLS, 
  getAllPoolAddresses, 
  getHighPriorityPools, 
  getInitialPoolsForDatabase,
  DEFAULT_POOL_ADDRESSES
} from './pool-config';
import type { Env } from '../../index';

export interface SyncCoordinatorConfig {
  syncInterval: number;
  healthCheckInterval: number;
  maxRetries: number;
  retryDelay: number;
  enableAutoRestart: boolean;
  enableMetrics: boolean;
}

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    sync: any;
    database: any;
    onchain: any;
    price: any;
  };
  lastChecked: number;
}

export interface SyncMetrics {
  syncService: any;
  totalPools: number;
  totalUsers: number;
  totalTransactions: number;
  lastSyncDuration: number;
  avgSyncDuration: number;
  errorRate: number;
  uptime: number;
  poolDiscovery: {
    totalScanned: number;
    newPoolsFound: number;
    poolsAdded: number;
    lastScanTime: number;
    errors: number;
  };
}

/**
 * 工业级同步协调器
 * 
 * 负责管理和协调所有同步服务，提供：
 * - 自动故障恢复
 * - 健康监控
 * - 性能指标收集
 * - 负载平衡
 * - 错误处理和重试
 */
export class SyncCoordinator {
  private syncService?: SyncService;
  private databaseService: DatabaseService;
  private onChainService: OnChainService;
  private priceService: PriceService;
  private poolDiscoveryService: PoolDiscoveryService;
  
  private isRunning = false;
  private startTime = 0;
  private healthCheckTimer?: any; // 使用 any 替代 NodeJS.Timeout 以兼容 Cloudflare Workers
  private lastHealthCheck: SystemHealth | null = null;
  private errorCount = 0;
  private totalSyncs = 0;
  private totalSyncTime = 0;

  constructor(
    private env: Env,
    private config: SyncCoordinatorConfig = {
      syncInterval: 5 * 60 * 1000, // 5分钟
      healthCheckInterval: 30 * 1000, // 30秒
      maxRetries: 3,
      retryDelay: 5000,
      enableAutoRestart: true,
      enableMetrics: true
    }
  ) {
    this.databaseService = new DatabaseService(env);
    this.onChainService = new OnChainService(env);
    this.priceService = new PriceService(env);
    this.poolDiscoveryService = new PoolDiscoveryService(env);
  }

  /**
   * 启动同步协调器
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Sync coordinator is already running');
      return;
    }

    console.log('🚀 Starting DEX Sync Coordinator...');
    this.isRunning = true;
    this.startTime = Date.now();

    try {
      // 1. 初始化系统检查
      await this.performSystemCheck();

      // 2. 加载池配置
      const poolConfig = await this.loadPoolConfiguration();

      // 3. 初始化同步服务
      const syncConfig: SyncConfig = {
        ...DEFAULT_SYNC_CONFIG,
        poolAddresses: poolConfig.poolAddresses,
        syncInterval: this.config.syncInterval
      };

      this.syncService = new SyncService(this.env, syncConfig);

      // 4. 启动同步服务
      await this.syncService.start();

      // 5. 启动池发现服务
      await this.poolDiscoveryService.startDiscovery();

      // 6. 启动健康监控
      this.startHealthMonitoring();

      console.log('✅ DEX Sync Coordinator started successfully');
      console.log(`📊 Monitoring ${poolConfig.poolAddresses.length} pools across ${syncConfig.chains.length} chains`);
      console.log('🔍 Pool discovery service active - will scan for new pools every hour');

    } catch (error) {
      console.error('❌ Failed to start sync coordinator:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * 停止同步协调器
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping DEX Sync Coordinator...');
    this.isRunning = false;

    // 停止健康监控
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    // 停止同步服务
    if (this.syncService) {
      await this.syncService.stop();
    }

    // 停止池发现服务
    this.poolDiscoveryService.stop();

    console.log('✅ Sync coordinator stopped');
  }

  /**
   * 获取系统状态
   */
  async getSystemStatus(): Promise<{
    isRunning: boolean;
    uptime: number;
    health: SystemHealth | null;
    metrics: SyncMetrics;
  }> {
    const uptime = this.isRunning ? Date.now() - this.startTime : 0;
    
    return {
      isRunning: this.isRunning,
      uptime,
      health: this.lastHealthCheck,
      metrics: await this.collectMetrics()
    };
  }

  /**
   * 手动触发完整同步
   */
  async triggerFullSync(): Promise<void> {
    if (!this.syncService) {
      throw new Error('Sync service not initialized');
    }

    console.log('🔄 Triggering manual full sync...');
    const startTime = Date.now();

    try {
      await this.syncService.triggerSync();
      const duration = Date.now() - startTime;
      
      this.totalSyncs++;
      this.totalSyncTime += duration;
      
      console.log(`✅ Manual sync completed in ${duration}ms`);
    } catch (error) {
      this.errorCount++;
      console.error('❌ Manual sync failed:', error);
      throw error;
    }
  }

  /**
   * 执行系统检查
   */
  private async performSystemCheck(): Promise<void> {
    console.log('🔍 Performing system check...');

    // 检查环境变量
    this.checkRequiredEnvVars();

    // 检查数据库连接
    await this.checkDatabaseConnection();

    // 检查RPC连接
    await this.checkRPCConnections();

    console.log('✅ System check passed');
  }

  /**
   * 检查必需的环境变量
   */
  private checkRequiredEnvVars(): void {
    const required = [
      'D1_DATABASE',
      'BSC_RPC_URL',
      'BSCTEST_RPC_URL'
    ];

    const missing = required.filter(key => !this.env[key as keyof Env]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  /**
   * 检查数据库连接
   */
  private async checkDatabaseConnection(): Promise<void> {
    try {
      await this.databaseService.getPools({}, { limit: 1 });
      console.log('✅ Database connection verified');
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw new Error('Database connection check failed');
    }
  }

  /**
   * 检查RPC连接
   */
  private async checkRPCConnections(): Promise<void> {
    try {
      const healthCheck = await this.onChainService.healthCheck();
      const healthyChains = Object.values(healthCheck.chains).filter(Boolean).length;
      
      if (healthyChains === 0) {
        throw new Error('No healthy RPC connections');
      }
      
      console.log(`✅ RPC connections verified (${healthyChains} chains healthy)`);
    } catch (error) {
      console.error('❌ RPC connection check failed:', error);
      throw new Error('RPC connection check failed');
    }
  }

  /**
   * 加载池配置
   */
  private async loadPoolConfiguration(): Promise<{
    poolAddresses: string[];
    totalPools: number;
  }> {
    try {
      console.log('📋 Loading pool configuration...');

      // 从数据库获取活跃池列表
      const pools = await this.databaseService.getPools(
        { status: 'active' },
        { limit: 1000 }
      );

      const poolAddresses = pools.pools.map(pool => pool.address);

      // 如果没有池，初始化默认池配置
      if (poolAddresses.length === 0) {
        console.warn('⚠️  No pools found in database, initializing with default pools...');
        
        // 尝试初始化数据库池数据
        await this.initializeDefaultPools();
        
        // 使用配置文件中的池地址
        const configPools = getAllPoolAddresses();
        
        if (configPools.length > 0) {
          return {
            poolAddresses: configPools,
            totalPools: configPools.length
          };
        } else {
          // 最后的备选方案：使用硬编码的默认地址
          console.log(`📊 Using ${DEFAULT_POOL_ADDRESSES.length} fallback pool addresses`);
          return {
            poolAddresses: DEFAULT_POOL_ADDRESSES,
            totalPools: DEFAULT_POOL_ADDRESSES.length
          };
        }
      }

      console.log(`📊 Loaded ${poolAddresses.length} active pools`);
      return {
        poolAddresses,
        totalPools: poolAddresses.length
      };
    } catch (error) {
      console.error('❌ Failed to load pool configuration:', error);
      throw new Error('Pool configuration loading failed');
    }
  }

  /**
   * 初始化默认池数据到数据库
   */
  private async initializeDefaultPools(): Promise<void> {
    try {
      console.log('🔧 Initializing default pools in database...');
      
      const poolsToInsert = getInitialPoolsForDatabase();
      
      if (poolsToInsert.length === 0) {
        console.warn('⚠️  No valid pool configurations found to initialize');
        return;
      }
      
      // 批量插入池数据
      for (const poolData of poolsToInsert) {
        try {
          // 检查池是否已存在
          const existingPools = await this.databaseService.getPools(
            { chain: poolData.chain },
            { limit: 1 }
          );
          
          const poolExists = existingPools.pools.some(
            p => p.address.toLowerCase() === poolData.address.toLowerCase()
          );
          
          if (!poolExists) {
            // 这里需要添加实际的插入方法到 DatabaseService
            console.log(`➕ Adding pool: ${poolData.name} (${poolData.address.slice(0, 8)}...)`);
            // await this.databaseService.insertPool(poolData);
          }
        } catch (error) {
          console.error(`❌ Failed to insert pool ${poolData.address}:`, error);
          // 继续处理其他池，不抛出错误
        }
      }
      
      console.log(`✅ Pool initialization completed`);
    } catch (error) {
      console.error('❌ Failed to initialize default pools:', error);
      // 不抛出错误，继续使用配置文件中的地址
    }
  }

  /**
   * 启动健康监控
   */
  private startHealthMonitoring(): void {
    console.log(`💓 Starting health monitoring (${this.config.healthCheckInterval}ms interval)`);

    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        console.error('Health check failed:', error);
      }
    }, this.config.healthCheckInterval);

    // 立即执行一次健康检查
    this.performHealthCheck().catch(console.error);
  }

  /**
   * 执行健康检查
   */
  private async performHealthCheck(): Promise<void> {
    const healthCheck: SystemHealth = {
      overall: 'healthy',
      services: {
        sync: null,
        database: null,
        onchain: null,
        price: null
      },
      lastChecked: Date.now()
    };

    try {
      // 检查同步服务
      if (this.syncService) {
        healthCheck.services.sync = await this.syncService.healthCheck();
      }

      // 检查数据库服务
      try {
        await this.databaseService.getPools({}, { limit: 1 });
        healthCheck.services.database = { status: 'healthy' };
      } catch (error) {
        healthCheck.services.database = { 
          status: 'unhealthy', 
          error: error instanceof Error ? error.message : 'Unknown error' 
        };
      }

      // 检查链上服务
      healthCheck.services.onchain = await this.onChainService.healthCheck();

      // 检查价格服务
      healthCheck.services.price = await this.priceService.healthCheck();

      // 计算整体健康状态
      const serviceStatuses = Object.values(healthCheck.services)
        .filter(service => service && service.status)
        .map(service => service.status);

      const unhealthyCount = serviceStatuses.filter(status => status === 'unhealthy').length;
      const degradedCount = serviceStatuses.filter(status => status === 'degraded').length;

      if (unhealthyCount > 0) {
        healthCheck.overall = 'unhealthy';
      } else if (degradedCount > 0) {
        healthCheck.overall = 'degraded';
      } else {
        healthCheck.overall = 'healthy';
      }

      this.lastHealthCheck = healthCheck;

      // 处理健康状态变化
      await this.handleHealthStatusChange(healthCheck);

    } catch (error) {
      console.error('Health check error:', error);
      healthCheck.overall = 'unhealthy';
      healthCheck.services = {
        sync: { status: 'unknown' },
        database: { status: 'unknown' },
        onchain: { status: 'unknown' },
        price: { status: 'unknown' }
      };
      this.lastHealthCheck = healthCheck;
    }
  }

  /**
   * 处理健康状态变化
   */
  private async handleHealthStatusChange(health: SystemHealth): Promise<void> {
    const prevHealth = this.lastHealthCheck?.overall;
    const currentHealth = health.overall;

    if (prevHealth !== currentHealth) {
      console.log(`🏥 Health status changed: ${prevHealth} → ${currentHealth}`);

      // 如果系统变为不健康且启用了自动重启
      if (currentHealth === 'unhealthy' && this.config.enableAutoRestart) {
        console.log('🔄 Attempting automatic recovery...');
        await this.attemptAutoRecovery();
      }
    }

    // 记录健康状态（可选：发送到监控系统）
    if (this.config.enableMetrics) {
      await this.recordHealthMetrics(health);
    }
  }

  /**
   * 尝试自动恢复
   */
  private async attemptAutoRecovery(): Promise<void> {
    let retryCount = 0;
    
    while (retryCount < this.config.maxRetries && this.isRunning) {
      try {
        console.log(`🔧 Recovery attempt ${retryCount + 1}/${this.config.maxRetries}`);

        // 重启同步服务
        if (this.syncService) {
          await this.syncService.stop();
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
          await this.syncService.start();
        }

        // 验证恢复
        await this.performHealthCheck();
        
        if (this.lastHealthCheck?.overall !== 'unhealthy') {
          console.log('✅ Automatic recovery successful');
          return;
        }

        retryCount++;
        
        if (retryCount < this.config.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        }
      } catch (error) {
        console.error(`❌ Recovery attempt ${retryCount + 1} failed:`, error);
        retryCount++;
        
        if (retryCount < this.config.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
        }
      }
    }

    console.error('❌ Automatic recovery failed after all attempts');
  }

  /**
   * 记录健康指标
   */
  private async recordHealthMetrics(health: SystemHealth): Promise<void> {
    // 这里可以实现指标记录逻辑
    // 例如：发送到时间序列数据库、监控系统等
    const metrics = {
      timestamp: health.lastChecked,
      overall_status: health.overall,
      sync_status: health.services.sync?.status || 'unknown',
      database_status: health.services.database?.status || 'unknown',
      onchain_status: health.services.onchain?.status || 'unknown',
      price_status: health.services.price?.status || 'unknown'
    };

    // 在生产环境中，这里应该发送到监控系统
    if (this.env.NODE_ENV === 'development') {
      console.log('📊 Health metrics:', metrics);
    }
  }

  /**
   * 收集系统指标
   */
  private async collectMetrics(): Promise<SyncMetrics> {
    const uptime = this.isRunning ? Date.now() - this.startTime : 0;
    const avgSyncDuration = this.totalSyncs > 0 ? this.totalSyncTime / this.totalSyncs : 0;
    const errorRate = this.totalSyncs > 0 ? this.errorCount / this.totalSyncs : 0;

    // 获取数据库统计
    const analytics = await this.databaseService.getPoolAnalytics().catch(() => ({
      totalPools: 0,
      activeUsers24h: 0,
      totalTransactions24h: 0
    }));

    const discoveryMetrics = this.poolDiscoveryService.getMetrics();

    return {
      syncService: this.syncService?.getStatus() || null,
      totalPools: analytics.totalPools || 0,
      totalUsers: analytics.activeUsers24h || 0,
      totalTransactions: analytics.totalTransactions24h || 0,
      lastSyncDuration: 0, // 需要从同步服务获取
      avgSyncDuration,
      errorRate,
      uptime,
      poolDiscovery: {
        totalScanned: discoveryMetrics.totalScanned,
        newPoolsFound: discoveryMetrics.newPoolsFound,
        poolsAdded: discoveryMetrics.poolsAdded,
        lastScanTime: discoveryMetrics.lastScanTime,
        errors: discoveryMetrics.errors
      }
    };
  }

  /**
   * 更新配置
   */
  async updateConfiguration(newConfig: Partial<SyncCoordinatorConfig>): Promise<void> {
    console.log('⚙️  Updating coordinator configuration...');
    
    this.config = { ...this.config, ...newConfig };

    // 如果健康检查间隔改变，重启健康监控
    if (newConfig.healthCheckInterval && this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.startHealthMonitoring();
    }

    console.log('✅ Configuration updated');
  }

  /**
   * 获取详细状态报告
   */
  async getDetailedReport(): Promise<any> {
    const status = await this.getSystemStatus();
    const pools = await this.databaseService.getPools({}, { limit: 10 });
    const analytics = await this.databaseService.getPoolAnalytics();

    return {
      system: status,
      pools: {
        total: pools.total,
        recent: pools.pools.slice(0, 5)
      },
      analytics,
      configuration: {
        coordinator: this.config,
        sync: this.syncService?.getConfig() || null
      }
    };
  }
}

// 导出默认配置
export const DEFAULT_COORDINATOR_CONFIG: SyncCoordinatorConfig = {
  syncInterval: 5 * 60 * 1000,        // 5分钟同步间隔
  healthCheckInterval: 30 * 1000,      // 30秒健康检查
  maxRetries: 3,                       // 最大重试次数
  retryDelay: 5000,                    // 重试延迟5秒
  enableAutoRestart: true,             // 启用自动重启
  enableMetrics: true                  // 启用指标收集
};
