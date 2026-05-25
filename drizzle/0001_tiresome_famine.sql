CREATE TABLE `interestSnapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`snapshotDate` timestamp NOT NULL,
	`accountName` varchar(64) NOT NULL,
	`interestUsd` text NOT NULL,
	`interestCount` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `interestSnapshots_id` PRIMARY KEY(`id`)
);
