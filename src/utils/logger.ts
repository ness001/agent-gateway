import * as vscode from "vscode";

import { currentRequestContext } from "../gateway/requestContext";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export const LOG_CHANNEL_NAME = "Agent Gateway";

export class Logger {
  private readonly outputChannel: vscode.LogOutputChannel;
  private level: LogLevel = "info";

  constructor(channelName: string) {
    this.outputChannel = vscode.window.createOutputChannel(channelName, {
      log: true,
    });
  }

  setLevel(level: LogLevel): void {
    this.level = LEVEL_RANK[level] === undefined ? "info" : level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Prefixes lines written during a request with its ID so borrowed route
   * warnings can be matched to the request summary line.
   */
  private tag<T>(message: T): T | string {
    const id = currentRequestContext()?.requestId;
    if (!id || typeof message !== "string" || message.startsWith(`[${id}]`)) {
      return message;
    }
    return `[${id}] ${message}`;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.level];
  }

  info(message: string, ...args: any[]): void {
    if (this.enabled("info")) {
      this.outputChannel.info(this.tag(message), ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.enabled("warn")) {
      this.outputChannel.warn(this.tag(message), ...args);
    }
  }

  error(message: string | Error, ...args: any[]): void {
    this.outputChannel.error(this.tag(message), ...args);
  }

  debug(message: string, ...args: any[]): void {
    if (this.enabled("debug")) {
      this.outputChannel.debug(this.tag(message), ...args);
    }
  }

  trace(message: string, ...args: any[]): void {
    if (this.enabled("debug")) {
      this.outputChannel.trace(this.tag(message), ...args);
    }
  }

  clear(): void {
    this.outputChannel.clear();
  }

  dispose(): void {
    this.outputChannel.dispose();
  }

  show(preserveFocus?: boolean): void {
    this.outputChannel.show(preserveFocus);
  }

  hide(): void {
    this.outputChannel.hide();
  }
}

export const logger = new Logger(LOG_CHANNEL_NAME);
