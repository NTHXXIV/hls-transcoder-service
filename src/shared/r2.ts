import { 
  DeleteObjectsCommand, 
  ListObjectsV2Command, 
  S3Client 
} from "@aws-sdk/client-s3";

export function createR2Client(endpoint: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

export async function cleanupPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
) {
  const listPrefix = `${prefix.replace(/\/$/, "")}/`;

  while (true) {
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: listPrefix,
      }),
    );

    const objects = listResponse.Contents ?? [];
    if (objects.length === 0) {
      break;
    }

    for (let index = 0; index < objects.length; index += 1000) {
      const chunk = objects.slice(index, index + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: chunk
              .filter((object) => object.Key)
              .map((object) => ({ Key: object.Key! })),
            Quiet: true,
          },
        }),
      );
    }

    if (!listResponse.IsTruncated) {
      break;
    }
  }
}
