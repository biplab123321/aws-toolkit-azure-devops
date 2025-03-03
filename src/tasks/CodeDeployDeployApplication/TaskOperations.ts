/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import CodeDeploy = require('aws-sdk/clients/codedeploy')
import AdmZip = require('adm-zip')
import S3 = require('aws-sdk/clients/s3')
import { AWSError } from 'aws-sdk/lib/error'
import * as tl from 'azure-pipelines-task-lib/task'
import { SdkUtils } from 'lib/sdkutils'
import fs = require('fs')
import path = require('path')
import {
    defaultTimeoutInMins,
    revisionSourceFromS3,
    revisionSourceFromWorkspace,
    TaskParameters
} from './TaskParameters'

export class TaskOperations {
    public constructor(
        public readonly codeDeployClient: CodeDeploy,
        public readonly s3Client: S3,
        public readonly taskParameters: TaskParameters
    ) {}

    public async execute(): Promise<void> {
        await this.verifyResourcesExist()

        let bundleKey: string
        switch (this.taskParameters.deploymentRevisionSource) {
            case revisionSourceFromWorkspace:
                bundleKey = await this.uploadBundle()
                break
            case revisionSourceFromS3:
                bundleKey = this.taskParameters.bundleKey
                break
            default:
                throw new Error(tl.loc('UnknownRevisionSource', this.taskParameters.deploymentRevisionSource))
        }

        const deploymentId: string = await this.deployRevision(bundleKey)

        if (this.taskParameters.outputVariable) {
            console.log(tl.loc('SettingOutputVariable', this.taskParameters.outputVariable))
            tl.setVariable(this.taskParameters.outputVariable, deploymentId)
        }

        await this.waitForDeploymentCompletion(
            this.taskParameters.applicationName,
            deploymentId,
            this.taskParameters.timeoutInMins
        )

        console.log(tl.loc('TaskCompleted', this.taskParameters.applicationName))
    }

    private async verifyResourcesExist(): Promise<void> {
        try {
            await this.codeDeployClient
                .getApplication({ applicationName: this.taskParameters.applicationName })
                .promise()
        } catch (err) {
            throw new Error(tl.loc('ApplicationDoesNotExist', this.taskParameters.applicationName))
        }

        try {
            await this.codeDeployClient
                .getDeploymentGroup({
                    applicationName: this.taskParameters.applicationName,
                    deploymentGroupName: this.taskParameters.deploymentGroupName
                })
                .promise()
        } catch (err) {
            throw new Error(
                tl.loc(
                    'DeploymentGroupDoesNotExist',
                    this.taskParameters.deploymentGroupName,
                    this.taskParameters.applicationName
                )
            )
        }

        if (this.taskParameters.deploymentRevisionSource === revisionSourceFromS3) {
            try {
                await this.s3Client
                    .headObject({
                        Bucket: this.taskParameters.bucketName,
                        Key: this.taskParameters.bundleKey
                    })
                    .promise()
            } catch (err) {
                throw new Error(
                    tl.loc('RevisionBundleDoesNotExist', this.taskParameters.bundleKey, this.taskParameters.bucketName)
                )
            }
        }
    }

    private async uploadBundle(): Promise<string> {
        let archiveName: string
        let autoCreatedArchive = false
        if (tl.stats(this.taskParameters.revisionBundle).isDirectory()) {
            autoCreatedArchive = true
            archiveName = await this.createDeploymentArchive(
                this.taskParameters.revisionBundle,
                this.taskParameters.applicationName
            )
        } else {
            archiveName = this.taskParameters.revisionBundle
        }

        let key: string
        const bundleFilename = path.basename(archiveName)
        if (this.taskParameters.bundlePrefix) {
            key = `${this.taskParameters.bundlePrefix}/${bundleFilename}`
        } else {
            key = bundleFilename
        }

        console.log(tl.loc('UploadingBundle', archiveName, key, this.taskParameters.bucketName))
        const fileBuffer = fs.createReadStream(archiveName)
        try {
            const request: S3.PutObjectRequest = {
                Bucket: this.taskParameters.bucketName,
                Key: key,
                Body: fileBuffer
            }

            if (this.taskParameters.filesAcl && this.taskParameters.filesAcl !== 'none') {
                request.ACL = this.taskParameters.filesAcl
            }

            await this.s3Client.upload(request).promise()
            console.log(tl.loc('BundleUploadCompleted'))

            // clean up the archive if we created one
            if (autoCreatedArchive) {
                console.log(tl.loc('DeletingUploadedBundle', archiveName))
                fs.unlinkSync(archiveName)
            }

            return key
        } catch (err) {
            console.error(tl.loc('BundleUploadFailed', (err as Error).message), err)
            throw err
        }
    }

    private async createDeploymentArchive(bundleFolder: string, applicationName: string): Promise<string> {
        console.log(tl.loc('CreatingDeploymentBundleArchiveFromFolder', bundleFolder))

        // echo what we do with Elastic Beanstalk deployments and use time as a version suffix,
        // creating the zip file inside the supplied folder
        const versionSuffix = `.v${new Date().getTime()}`
        const tempDir = SdkUtils.getTempLocation()
        const archive = path.join(tempDir, `${applicationName}${versionSuffix}.zip`)

        const zip = new AdmZip()

        try {
            zip.addLocalFolder(bundleFolder)
            zip.writeZip(archive)
        } catch (err) {
            console.log(tl.loc('ZipError', err))
            throw err
        }

        console.log(tl.loc('CreatedBundleArchive', archive))

        return archive
    }

    private async deployRevision(bundleKey: string): Promise<string> {
        console.log(tl.loc('DeployingRevision'))

        // use bundle key as taskParameters.revisionBundle might be pointing at a folder
        let archiveType: string = path.extname(bundleKey)
        if (archiveType && archiveType.length > 1) {
            // let the service error out if the type is not one they currently support
            archiveType = archiveType.substring(1).toLowerCase()
            tl.debug(`Setting archive type to ${archiveType} based on bundle file extension`)
        } else {
            tl.debug('Unable to determine archive type, assuming zip')
            archiveType = 'zip'
        }

        try {
            const request: CodeDeploy.CreateDeploymentInput = {
                applicationName: this.taskParameters.applicationName,
                deploymentGroupName: this.taskParameters.deploymentGroupName,
                fileExistsBehavior: this.taskParameters.fileExistsBehavior,
                ignoreApplicationStopFailures: this.taskParameters.ignoreApplicationStopFailures,
                updateOutdatedInstancesOnly: this.taskParameters.updateOutdatedInstancesOnly,
                revision: {
                    revisionType: 'S3',
                    s3Location: {
                        bucket: this.taskParameters.bucketName,
                        key: bundleKey,
                        bundleType: archiveType
                    }
                }
            }

            if (this.taskParameters.description) {
                request.description = this.taskParameters.description
            }
            const response: CodeDeploy.CreateDeploymentOutput = await this.codeDeployClient
                .createDeployment(request)
                .promise()
            console.log(
                tl.loc(
                    'DeploymentStarted',
                    this.taskParameters.deploymentGroupName,
                    this.taskParameters.applicationName,
                    response.deploymentId
                )
            )

            if (!response.deploymentId) {
                return ''
            }

            return response.deploymentId
        } catch (err) {
            console.error(tl.loc('DeploymentError', (err as Error).message), err)
            throw err
        }
    }

    private async waitForDeploymentCompletion(
        applicationName: string,
        deploymentId: string,
        timeout: number
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            console.log(tl.loc('WaitingForDeployment'))

            const params: any = this.setWaiterParams(deploymentId, timeout)
            this.codeDeployClient.waitFor('deploymentSuccessful', params, function(
                err: AWSError,
                data: CodeDeploy.GetDeploymentOutput
            ) {
                if (err) {
                    reject(new Error(tl.loc('DeploymentFailed', applicationName, err.message)))
                } else {
                    console.log(tl.loc('WaitConditionSatisifed'))
                    resolve()
                }
            })
        })
    }

    private setWaiterParams(deploymentId: string, timeout: number): any {
        if (timeout !== defaultTimeoutInMins) {
            console.log(tl.loc('SettingCustomTimeout', timeout))
        }

        const p: any = {
            deploymentId,
            // this magic number comes from the code deploy client attempting every 15 seconds
            $waiter: {
                maxAttempts: Math.round((timeout * 60) / 15)
            }
        }

        return p
    }
}
