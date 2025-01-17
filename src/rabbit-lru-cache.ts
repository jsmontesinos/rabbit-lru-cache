import * as LRUCache from "lru-cache";
import { connect, Options, ConsumeMessage, Channel, Connection } from "amqplib";
import * as uuid from "uuid";
import { ClosingError } from "./errors/ClosingError";
import { notEqual } from "assert";
import { EventEmitter } from "events";
import once from "./utils/once";

export type RabbitLRUCache<T> = {
    close: () => Promise<void>;
    getItemCount: () => number;
    doesAllowStale: () => boolean;
    getLength: () => number;
    getMax: () => number;
    getMaxAge: () => number;
    getOrLoad: (key: string, loadItem: (key: string) => Promise<T>) => Promise<T>;
    has: (key: string) => boolean;
    keys: () => string[];
    del: (key: string) => void;
    reset: () => void;
    prune: () => void;
    addInvalidationMessageReceivedListener(fn: (messageContent: string, publisherCacheId: string) => void): void;
    removeInvalidationMessageReceivedListener(fn: (messageContent: string, publisherCacheId: string) => void): void;
    addReconnectingListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void;
    removeReconnectingListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void;
    addReconnectedListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void;
    removeReconnectedListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void;
};

export type RabbitLRUCacheOptions<T> = {
    name: string;
    LRUCacheOptions: LRUCache.Options<string, T>;
    amqpConnectOptions: Options.Connect;
    reconnectionOptions?: {
        allowStaleData?: boolean;
        retryIntervalUpTo?: number;
        retryIntervalIncrease?: number;
    };
};

export async function createRabbitLRUCache<T>(options: RabbitLRUCacheOptions<T>): Promise<RabbitLRUCache<T>> {
    notEqual(options, null, "options is required");
    notEqual(options.name, null, "options.name is required");
    notEqual(options.name, "", "options.name is required");
    notEqual(options.LRUCacheOptions, null, "options.LRUCacheOptions is required");
    notEqual(options.amqpConnectOptions, null, "options.amqpConnectOptions is required");

    const eventEmitter = new EventEmitter();
    let closing = false;
    let reconnecting = false;

    const cacheId = uuid.v1();
    const cache = new LRUCache<string, T>(options.LRUCacheOptions);

    let connection: Connection;
    let publisherChannel: Channel, subscriberChannel: Channel;
    const exchangeName = `rabbit-lru-cache-${options.name}`;

    let loadItemPromises: { [key: string]: Promise<T> } = {};

    function internalReset(): void {
        loadItemPromises = {};
        cache.reset();
    }

    function internalDel(key: string): void {
        if (loadItemPromises[key]) {
            delete loadItemPromises[key];
        }
        cache.del(key);
    }

    async function createConnection(options: Options.Connect, handleConnectionError: (error: Error, attempt: number, retryInterval: number) => Promise<void>): Promise<Connection> {
        const connection = await connect(options);
        connection.removeAllListeners("error");
        const errorHandler = once(handleConnectionError);
        connection.on("error", errorHandler);
        connection.on("close", errorHandler);
        return connection;
    }

    async function createPublisher(connection: Connection, exchangeName: string): Promise<Channel> {
        const channel = await connection.createChannel();
        await channel.assertExchange(exchangeName, "fanout", { durable: false });
        return channel;
    }

    async function createConsumer(connection: Connection, exchangeName: string, cacheId: string): Promise<Channel> {
        const channel = await connection.createChannel();
        const queueName = `${exchangeName}-${cacheId}`;
        await channel.assertQueue(queueName, {
            durable: false,
            exclusive: true,
            autoDelete: true
        });
        await channel.bindQueue(queueName, exchangeName, "");
        await channel.consume(queueName, function onMessage(msg: ConsumeMessage | null) {
            if (msg === null) {
                throw new Error("consumer has been cancelled by RabbitMq");
            }
            const publisherCacheId = msg.properties.headers["x-cache-id"];
            if (publisherCacheId === cacheId) {
                return;
            }
            const content = msg.content.toString();
            if (content === "reset") {
                internalReset();
            } else if (content.startsWith("del:")) {
                const key = content.substring(4);
                internalDel(key);
            }
            eventEmitter.emit("invalidation-message-received", content, publisherCacheId);
        }, { exclusive: true, noAck: true, consumerTag: cacheId });
        return channel;
    }

    async function handleConnectionError(error: Error, attempt = 0, retryInterval = 0): Promise<void> {
        if (closing) {
            return;
        }
        const retryIntervalIncrease = options.reconnectionOptions?.retryIntervalIncrease ?? 1000;
        const retryIntervalUpTo = options.reconnectionOptions?.retryIntervalUpTo ?? 60000;
        try {
            attempt++;
            reconnecting = true;
            internalReset();
            eventEmitter.emit("reconnecting", error, attempt, retryInterval);
            connection = await createConnection(options.amqpConnectOptions, handleConnectionError);
            publisherChannel = await createPublisher(connection, exchangeName);
            subscriberChannel = await createConsumer(connection, exchangeName, cacheId);
            reconnecting = false;
            internalReset();
            eventEmitter.emit("reconnected", error, attempt, retryInterval);
        } catch(error) {
            if (retryInterval < retryIntervalUpTo) {
                retryInterval = retryInterval + retryIntervalIncrease;
            }
            setTimeout(handleConnectionError.bind(null, error, attempt, retryInterval), retryInterval);
        }
    }

    connection = await createConnection(options.amqpConnectOptions, handleConnectionError);
    publisherChannel = await createPublisher(connection, exchangeName);
    subscriberChannel = await createConsumer(connection, exchangeName, cacheId);

    function assertIsClosingOrClosed(): void {
        if (closing) {
            throw new ClosingError("Cache is closing or has been closed");
        }
    }

    function assertIsClosingOrClosedDecorator<TT>(fn: (...args) => TT): (...args) => TT {
        return function(...args): TT {
            assertIsClosingOrClosed();
            return fn(...args);
        }
    }

    function publish(message: string): void {
        if (reconnecting) {
            return;
        }
        publisherChannel.publish(exchangeName, "", Buffer.from(message), { headers: {
            "x-cache-id": cacheId
        }});
    }

    return {
        /**
         * Deletes an item by key
         *
         * @param {string} key
         */
        del(key: string): void {
            assertIsClosingOrClosed();
            publish(`del:${key}`);
            internalDel(key);
        },
        /**
         * Resets the entire cache and distribute the reset command to all subscribers.         *
         */
        reset(): void {
            assertIsClosingOrClosed();
            publish("reset");
            internalReset();
        },
        /**
         * This function checks if the item is in the cache and if so returns it, otherwise 
         * it invokes the loadItem function to retrieve the item and then it stores it in the cache.
         *
         * @param {string} key
         * @param {(key: string) => Promise<T>} loadItem
         * @returns {Promise<T>}
         */
        async getOrLoad(key: string, loadItem: (key: string) => Promise<T>): Promise<T> {
            assertIsClosingOrClosed();
            const item = cache.get(key);
            if (item !== undefined && item !== null) {
                return item;
            }
            if (loadItemPromises[key]) {
                return loadItemPromises[key];
            }
            loadItemPromises[key] = loadItem(key);
            try {
                const loadedItem = await loadItemPromises[key];
                if ((options.reconnectionOptions?.allowStaleData || !reconnecting) && 
                    loadItemPromises[key] && 
                    (loadedItem !== undefined && loadedItem !== null)) {
                    cache.set(key, loadedItem);
                }
                return loadedItem;
            } finally {
                if (loadItemPromises[key]) {
                    delete loadItemPromises[key];
                }
            }
        },
        has: assertIsClosingOrClosedDecorator(cache.has.bind(cache)),
        keys: assertIsClosingOrClosedDecorator(cache.keys.bind(cache)),
        doesAllowStale(): boolean {
            assertIsClosingOrClosed();
            return cache.allowStale;
        },
        getItemCount(): number {
            assertIsClosingOrClosed();
            return cache.itemCount;
        },
        getLength(): number {
            assertIsClosingOrClosed();
            return cache.length;
        },
        getMax(): number {
            assertIsClosingOrClosed();
            return cache.max;
        },
        getMaxAge(): number {
            assertIsClosingOrClosed();
            return cache.maxAge;
        },
        async close(): Promise<void> {
            closing = true;
            await subscriberChannel.cancel(cacheId);
            await Promise.all([
                subscriberChannel.close(),
                publisherChannel.close()
            ]);
            await connection.close();
            cache.reset();
        },
        prune() {
            assertIsClosingOrClosed();
            cache.prune();
        },
        addInvalidationMessageReceivedListener(fn: (messageContent: string, publisherCacheId: string) => void): void {
            eventEmitter.addListener("invalidation-message-received", fn);
        },
        removeInvalidationMessageReceivedListener(fn: (messageContent: string, publisherCacheId: string) => void): void {
            eventEmitter.removeListener("invalidation-message-received", fn);
        },
        addReconnectingListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void {
            eventEmitter.addListener("reconnecting", fn);
        },
        removeReconnectingListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void {
            eventEmitter.removeListener("reconnecting", fn);
        },
        addReconnectedListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void {
            eventEmitter.addListener("reconnected", fn);
        },
        removeReconnectedListener(fn: (error: Error, attempt: number, retryInterval: number) => void): void {
            eventEmitter.removeListener("reconnected", fn);
        }
    };
}