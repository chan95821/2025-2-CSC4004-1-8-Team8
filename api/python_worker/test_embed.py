#!/usr/bin/env python3
"""
Test script for the embed API endpoint.
"""

import asyncio
import httpx
import json
from typing import List, Dict, Any

# Test data
test_nodes = [
    {
        "id": "node1",
        "content": "Test content 1"
    },
    {
        "id": "node2",
        "content": "Test content 2"
    }
]

test_request = {
    "user_id": "test_user2",
    "nodes": test_nodes
}

async def test_embed_api():
    """Test the /embed endpoint"""
    async with httpx.AsyncClient(base_url="http://localhost:8000") as client:
        try:
            print("Testing embed API...")
            print(f"Sending request: {json.dumps(test_request, indent=2)}")

            response = await client.post("/embed/node", json=test_request)

            print(f"Status Code: {response.status_code}")
            print(f"Response: {response.json()}")

            if response.status_code == 200:
                print("✅ Embed API test passed!")
            else:
                print("❌ Embed API test failed!")

        except httpx.ConnectError:
            print("❌ Connection failed. Is the server running on http://localhost:8000?")
        except Exception as e:
            print(f"❌ Test failed with error: {e}")

if __name__ == "__main__":
    asyncio.run(test_embed_api())