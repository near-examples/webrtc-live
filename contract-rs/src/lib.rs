use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

use near_sdk::collections::Map;
use near_sdk::{env, near_bindgen};

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

type Stream = String;
type StreamKey = String;
type AccountId = String;
type EncryptedSecretKey = String;

#[derive(BorshDeserialize, BorshSerialize, Serialize)]
pub struct StreamInfo {
    owner_id: AccountId,
    offer: Option<Stream>,
    answer: Option<Answer>,
    restreams: Vec<EncryptedSecretKey>,
}

#[derive(BorshDeserialize, BorshSerialize, Deserialize, Serialize, Debug, Eq, PartialEq)]
pub struct Answer {
    account_id: AccountId,
    stream: Stream,
    restream_key: EncryptedSecretKey,
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct WebRTCHub {
    streams: Map<StreamKey, StreamInfo>,
}

impl Default for WebRTCHub {
    fn default() -> Self {
        env::panic(b"Not initialized yet.");
    }
}

#[near_bindgen]
impl WebRTCHub {
    #[init]
    pub fn new() -> Self {
        assert!(
            env::state_read::<WebRTCHub>().is_none(),
            "The contract is already initialized"
        );
        Self {
            streams: Map::new(b"s".to_vec()),
        }
    }

    pub fn offer(&mut self, key: StreamKey, offer: Option<Stream>, is_new: bool) {
        if is_new {
            let prev = self.streams.insert(
                &key,
                &StreamInfo {
                    owner_id: env::predecessor_account_id(),
                    offer,
                    answer: None,
                    restreams: vec![],
                },
            );
            if let Some(StreamInfo { owner_id, .. }) = prev {
                assert_eq!(
                    owner_id,
                    env::predecessor_account_id(),
                    "This streaming key is owned by another account"
                );
            }
        } else {
            let mut info = self.streams.get(&key).expect("Stream not found");
            assert_eq!(
                info.owner_id,
                env::predecessor_account_id(),
                "This streaming key is owned by another account"
            );
            info.offer = offer;
        }
    }

    pub fn answer(
        &mut self,
        key: StreamKey,
        stream: Stream,
        is_new: bool,
        offer: Stream,
        restream_key: EncryptedSecretKey,
    ) {
        let mut info = self.streams.get(&key).expect("Stream not found");
        let offer = Some(offer);
        if info.offer != offer {
            env::panic(b"Current offer is different");
        }
        if is_new {
            assert!(info.answer.is_none(), "Answer already present");
        } else {
            let old_answer = info.answer.expect("Expected old answer");
            assert_eq!(
                old_answer.account_id,
                env::predecessor_account_id(),
                "Old answer is from the different owner"
            );
        }
        assert_ne!(
            info.owner_id,
            env::predecessor_account_id(),
            "Can't answer your own offer"
        );
        info.answer = Some(Answer {
            account_id: env::predecessor_account_id(),
            stream,
            restream_key,
        });
        self.streams.insert(&key, &info);
    }

    pub fn take_answer(&mut self, key: StreamKey, answer: Answer) {
        let mut info = self.streams.get(&key).expect("Stream not found");
        assert_eq!(
            info.owner_id,
            env::predecessor_account_id(),
            "This streaming key is owned by another account"
        );
        info.restreams.push(answer.restream_key.clone());
        if info.answer != Some(answer) {
            env::panic(b"The answer has changed");
        }
        info.answer = None;
        info.offer = None;
        self.streams.insert(&key, &info);
    }

    pub fn get(&self, key: StreamKey) -> Option<StreamInfo> {
        self.streams.get(&key)
    }
}
