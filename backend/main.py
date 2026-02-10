"""
ASR Dashboard Backend
Connects React frontend to Redis database
Manages Docker containers for ASR modules
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import redis
import json
import asyncio
import os
import time
from typing import Optional, List
from datetime import datetime

# Docker SDK
try:
    import docker
    DOCKER_AVAILABLE = True
except ImportError:
    DOCKER_AVAILABLE = False

app = FastAPI(title="ASR Dashboard API")

# CORS - allow frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Redis connection
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "") or None  # Пустая строка = без пароля

# Docker settings
ASR_IMAGE = os.getenv("ASR_IMAGE", "asr-module:latest")
DOCKER_NETWORK = os.getenv("DOCKER_NETWORK", "asr-network")

def get_redis():
    return redis.Redis(
        host=REDIS_HOST, 
        port=REDIS_PORT, 
        password=REDIS_PASSWORD,
        decode_responses=True
    )

def get_docker():
    """Get Docker client if available"""
    if not DOCKER_AVAILABLE:
        return None
    try:
        return docker.from_env()
    except Exception as e:
        print(f"Docker not available: {e}")
        return None


# ============ Health Check ============

@app.get("/")
def root():
    """Health check"""
    docker_client = get_docker()
    return {
        "status": "ok",
        "service": "asr-dashboard-api",
        "docker_available": docker_client is not None
    }


# ============ Stats ============

@app.get("/api/stats")
def get_stats():
    """Get overall statistics"""
    r = get_redis()
    
    tokens_count = r.hlen("tokens")
    current_counts = r.hgetall("tokens_current_counts")
    total_detections = sum(int(v) for v in current_counts.values()) if current_counts else 0
    
    orderbook_keys = r.keys("orderbook:*")
    orderbooks_count = len(orderbook_keys)
    
    top_token = None
    top_count = 0
    if current_counts:
        for token_id, count in current_counts.items():
            if int(count) > top_count:
                top_count = int(count)
                top_token = token_id
    
    return {
        "total_detections": total_detections,
        "unique_tokens": len(current_counts),
        "tracked_tokens": tokens_count,
        "orderbooks_count": orderbooks_count,
        "top_token": {"id": top_token, "count": top_count} if top_token else None
    }


# ============ Tokens ============

@app.get("/api/tokens")
def get_tokens(
    search: Optional[str] = None,
    sort_by: str = Query("count", enum=["count", "name"]),
    limit: int = 100
):
    """Get all tokens with their counts"""
    r = get_redis()
    
    current_counts = r.hgetall("tokens_current_counts")
    
    tokens = []
    for token_id, count in current_counts.items():
        if search and search.lower() not in token_id.lower():
            continue
        tokens.append({
            "id": token_id,
            "count": int(count)
        })
    
    if sort_by == "count":
        tokens.sort(key=lambda x: x["count"], reverse=True)
    else:
        tokens.sort(key=lambda x: x["id"])
    
    return {"tokens": tokens[:limit], "total": len(tokens)}


@app.get("/api/tokens/{token_id}")
def get_token(token_id: str):
    """Get single token details"""
    r = get_redis()
    
    count = r.hget("tokens_current_counts", token_id)
    if count is None:
        raise HTTPException(status_code=404, detail="Token not found")
    
    orderbook_key = f"orderbook:{token_id}"
    has_orderbook = r.exists(orderbook_key)
    
    return {
        "id": token_id,
        "count": int(count),
        "has_orderbook": bool(has_orderbook)
    }


# ============ Orderbook ============

@app.get("/api/orderbook/{token_id}")
def get_orderbook(token_id: str, history: int = 100, include_empty: bool = False):
    """Get orderbook for a token with full history"""
    r = get_redis()
    
    key = f"orderbook:{token_id}"
    
    if not r.exists(key):
        raise HTTPException(status_code=404, detail="Orderbook not found")
    
    entries = r.zrevrange(key, 0, history - 1, withscores=True)
    
    result = []
    for data, score in entries:
        try:
            parsed = json.loads(data)
            parsed["_timestamp"] = int(score)
            
            if not include_empty:
                has_asks = parsed.get("asks") and len(parsed["asks"]) > 0
                has_bids = parsed.get("bids") and len(parsed["bids"]) > 0
                if not has_asks and not has_bids:
                    continue
            
            result.append(parsed)
                
        except json.JSONDecodeError:
            continue
    
    if not result and entries:
        try:
            data, score = entries[0]
            parsed = json.loads(data)
            parsed["_timestamp"] = int(score)
            result.append(parsed)
        except:
            pass
    
    total_count = r.zcard(key)
    
    return {
        "token_id": token_id, 
        "snapshots": result,
        "total_snapshots": total_count
    }


@app.get("/api/orderbook/{token_id}/best-price")
def get_best_price(token_id: str, target_price: Optional[float] = None):
    """
    Find the best ask price in history.
    If target_price is provided, find when price was <= target_price.
    """
    r = get_redis()
    
    key = f"orderbook:{token_id}"
    
    if not r.exists(key):
        raise HTTPException(status_code=404, detail="Orderbook not found")
    
    entries = r.zrevrange(key, 0, 99, withscores=True)
    
    best_price = None
    best_timestamp = None
    current_price = None
    target_found_timestamp = None
    target_found_price = None
    
    for i, (data, score) in enumerate(entries):
        try:
            parsed = json.loads(data)
            asks = parsed.get("asks", [])
            
            if not asks or len(asks) == 0:
                continue
            
            # Handle different formats: [[price, size], ...] or [{price: x, size: y}, ...]
            first_ask = asks[0]
            if isinstance(first_ask, list):
                price = float(first_ask[0])
            elif isinstance(first_ask, dict):
                price = float(first_ask.get("price", first_ask.get("p", 0)))
            else:
                price = float(first_ask)
            
            if price <= 0:
                continue
                
            timestamp = int(score)
            
            # Current price is the first one (newest)
            if current_price is None:
                current_price = price
            
            # Track best (lowest) price ever
            if best_price is None or price < best_price:
                best_price = price
                best_timestamp = timestamp
            
            # Find when price was <= target (most recent occurrence)
            if target_price is not None and price <= target_price:
                if target_found_timestamp is None:
                    target_found_timestamp = timestamp
                    target_found_price = price
                
        except (json.JSONDecodeError, KeyError, IndexError, ValueError, TypeError) as e:
            continue
    
    result = {
        "token_id": token_id,
        "best_price": best_price,
        "best_timestamp": best_timestamp,
        "current_price": current_price,
        "difference": round(current_price - best_price, 4) if (current_price and best_price) else None,
        "snapshots_checked": len(entries)
    }
    
    # Add target search results if requested
    if target_price is not None:
        result["target_price"] = target_price
        result["target_found"] = target_found_timestamp is not None
        result["target_found_timestamp"] = target_found_timestamp
        result["target_found_price"] = target_found_price
    
    return result


@app.get("/api/orderbook/{token_id}/debug")
def debug_orderbook(token_id: str):
    """Debug: show raw orderbook data format"""
    r = get_redis()
    
    key = f"orderbook:{token_id}"
    
    if not r.exists(key):
        raise HTTPException(status_code=404, detail="Orderbook not found")
    
    entries = r.zrevrange(key, 0, 2, withscores=True)
    
    samples = []
    for data, score in entries:
        try:
            parsed = json.loads(data)
            asks = parsed.get("asks", [])
            samples.append({
                "timestamp": int(score),
                "asks_count": len(asks),
                "asks_sample": asks[:2] if asks else None,
                "asks_type": type(asks[0]).__name__ if asks else None,
                "raw_keys": list(parsed.keys())
            })
        except Exception as e:
            samples.append({"error": str(e), "raw": data[:200]})
    
    return {"token_id": token_id, "samples": samples}


@app.get("/api/orderbooks")
def list_orderbooks(search: Optional[str] = None, limit: int = 100):
    """List all orderbook keys"""
    r = get_redis()
    
    pattern = f"orderbook:*{search}*" if search else "orderbook:*"
    keys = r.keys(pattern)
    
    token_ids = [k.replace("orderbook:", "") for k in keys]
    token_ids.sort()
    
    return {"orderbooks": token_ids[:limit], "total": len(token_ids)}


# ============ Stream ============

@app.get("/api/stream/updates")
async def stream_updates():
    """Server-Sent Events stream for real-time updates"""
    
    async def event_generator():
        r = get_redis()
        last_id = "$"
        
        while True:
            try:
                entries = r.xread(
                    {"tokens_updates_stream": last_id},
                    count=10,
                    block=1000
                )
                
                if entries:
                    for stream_name, messages in entries:
                        for msg_id, data in messages:
                            last_id = msg_id
                            event_data = {
                                "id": msg_id,
                                "token_id": data.get("token_id"),
                                "count": data.get("count"),
                                "container_id": data.get("container_id"),
                                "timestamp": datetime.now().isoformat()
                            }
                            yield f"data: {json.dumps(event_data)}\n\n"
                else:
                    yield f": heartbeat\n\n"
                    
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                await asyncio.sleep(1)
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@app.get("/api/stream/history")
def get_stream_history(count: int = 50):
    """Get recent updates from stream"""
    r = get_redis()
    
    entries = r.xrevrange("tokens_updates_stream", count=count)
    
    result = []
    for msg_id, data in entries:
        result.append({
            "id": msg_id,
            "token_id": data.get("token_id"),
            "count": data.get("count"),
            "container_id": data.get("container_id"),
            "timestamp": data.get("timestamp"),
        })
    
    return {"updates": result}


@app.get("/api/stream/container-stats")
def get_container_stats(count: int = 1000):
    """Get statistics per container"""
    r = get_redis()
    
    entries = r.xrevrange("tokens_updates_stream", count=count)
    
    stats = {}
    for msg_id, data in entries:
        container_id = data.get("container_id", "unknown")
        if container_id not in stats:
            stats[container_id] = {
                "container_id": container_id,
                "detections": 0,
                "tokens": set(),
                "first_seen": None,
                "last_seen": None
            }
        
        stats[container_id]["detections"] += 1
        stats[container_id]["tokens"].add(data.get("token_id", ""))
        
        timestamp = data.get("timestamp")
        if timestamp:
            ts = int(timestamp)
            if stats[container_id]["last_seen"] is None:
                stats[container_id]["last_seen"] = ts
            stats[container_id]["first_seen"] = ts
    
    # Convert sets to counts
    result = []
    for cid, s in stats.items():
        result.append({
            "container_id": s["container_id"],
            "detections": s["detections"],
            "unique_tokens": len(s["tokens"]),
            "first_seen": s["first_seen"],
            "last_seen": s["last_seen"]
        })
    
    # Sort by detections
    result.sort(key=lambda x: x["detections"], reverse=True)
    
    return {"containers": result, "total_entries": len(entries)}


@app.get("/api/stream/races")
def get_detection_races(count: int = 1000, time_window_ms: int = 0):
    """
    Find 'races' - when multiple containers detected the same token.
    Groups detections of the same token+count.
    time_window_ms=0 means no time limit.
    """
    r = get_redis()
    
    entries = r.xrevrange("tokens_updates_stream", count=count)
    
    # Group by token_id and count
    # Key: (token_id, count) -> list of detections
    groups = {}
    
    for msg_id, data in entries:
        token_id = data.get("token_id")
        count_val = data.get("count")
        container_id = data.get("container_id", "unknown")
        
        # Use timestamp from stream ID (format: "1706045522857-0")
        # This is the ACTUAL time when the message was added to Redis
        # (same approach as list_asr_streams.py)
        try:
            timestamp = int(msg_id.split("-")[0])
        except:
            timestamp = 0
        
        key = (token_id, count_val)
        if key not in groups:
            groups[key] = []
        
        groups[key].append({
            "container_id": container_id,
            "timestamp": timestamp,
            "msg_id": msg_id
        })
    
    # Find races (more than 1 container for same token+count)
    races = []
    for (token_id, count_val), detections in groups.items():
        if len(detections) < 2:
            continue
        
        # Sort by timestamp (fastest first)
        detections.sort(key=lambda x: x["timestamp"])
        
        # Check if within time window (if specified)
        first_ts = detections[0]["timestamp"]
        last_ts = detections[-1]["timestamp"]
        time_spread = last_ts - first_ts
        
        if time_window_ms > 0 and time_spread > time_window_ms:
            continue  # Too far apart, not a race
        
        # Calculate diffs from fastest
        fastest_ts = first_ts
        results = []
        for i, d in enumerate(detections):
            diff_ms = d["timestamp"] - fastest_ts
            results.append({
                "place": i + 1,
                "container_id": d["container_id"],
                "timestamp": d["timestamp"],
                "diff_ms": diff_ms,
                "is_fastest": i == 0  # Only first is fastest
            })
        
        races.append({
            "token_id": token_id,
            "count": count_val,
            "participants": len(detections),
            "winner": detections[0]["container_id"],
            "results": results,
            "time_spread_ms": time_spread
        })
    
    # Sort by most recent
    races.sort(key=lambda x: x["results"][0]["timestamp"] if x["results"] else 0, reverse=True)
    
    return {"races": races[:100], "total_races": len(races)}


# ============ Docker Container Management ============

class LaunchConfig(BaseModel):
    name: str = "asr-module"
    input: str = ""  # Stream URL
    words: str = ""  # CSV file path
    reference: str = ""  # Reference voice(s)
    similarity_threshold: float = 0.70
    format: str = "bestaudio/best[height<=360]/worst"
    downloader: str = ""
    monitor_interval: int = 5
    hls_interval: float = 0.1
    chunk_size_ms: int = 5000
    print_transcript: bool = False
    first_therm: bool = False
    autostart: bool = False
    verbose: bool = False
    no_hls_skip: bool = False
    simulate_realtime: bool = False
    use_fc: bool = False


def build_asr_command(config: LaunchConfig) -> List[str]:
    """Build command arguments for ASR container"""
    cmd = []
    
    if config.words:
        cmd.extend(["--words", config.words])
    if config.reference:
        cmd.extend(["--reference", config.reference])
    if config.similarity_threshold != 0.70:
        cmd.extend(["--similarity_threshold", str(config.similarity_threshold)])
    if config.format and config.format != "bestaudio/best[height<=360]/worst":
        cmd.extend(["--format", config.format])
    if config.downloader:
        cmd.extend(["--downloader", config.downloader])
    if config.monitor_interval != 5:
        cmd.extend(["--monitor-interval", str(config.monitor_interval)])
    if config.hls_interval != 0.1:
        cmd.extend(["--hls-interval", str(config.hls_interval)])
    if config.chunk_size_ms != 5000:
        cmd.extend(["--chunk-size-ms", str(config.chunk_size_ms)])
    if config.print_transcript:
        cmd.append("--print-transcript")
    if config.first_therm:
        cmd.append("--first-therm")
    if config.autostart:
        cmd.append("--autostart")
    if config.verbose:
        cmd.append("--verbose")
    if config.no_hls_skip:
        cmd.append("--no-hls-skip")
    if config.simulate_realtime:
        cmd.append("--simulate-realtime")
    if config.use_fc:
        cmd.append("--use-fc")
    if config.input:
        cmd.append(config.input)
    
    return cmd


def build_docker_command(config: LaunchConfig) -> str:
    """Build docker run command string for display"""
    parts = ["docker", "run", "-d"]
    parts.extend(["--name", config.name])
    parts.extend(["--network", DOCKER_NETWORK])
    parts.extend(["-e", f"REDIS_HOST={REDIS_HOST}"])
    parts.extend(["-e", f"REDIS_PORT={REDIS_PORT}"])
    parts.append(ASR_IMAGE)
    parts.extend(build_asr_command(config))
    
    return " ".join(parts)


@app.post("/api/module/launch")
def launch_module(config: LaunchConfig):
    """Launch ASR module container"""
    docker_client = get_docker()
    command = build_docker_command(config)
    
    if not docker_client:
        return {
            "status": "error",
            "message": "Docker is not available. Run manually:",
            "command": command,
            "docker_available": False
        }
    
    try:
        # Check if container with same name exists
        try:
            existing = docker_client.containers.get(config.name)
            if existing.status == "running":
                return {
                    "status": "error",
                    "message": f"Container '{config.name}' is already running",
                    "command": command,
                    "container_id": existing.short_id
                }
            else:
                existing.remove()
        except docker.errors.NotFound:
            pass
        
        # Build command for container
        cmd = build_asr_command(config)
        
        # Run container
        container = docker_client.containers.run(
            ASR_IMAGE,
            command=cmd,
            name=config.name,
            detach=True,
            network=DOCKER_NETWORK,
            environment={
                "REDIS_HOST": REDIS_HOST,
                "REDIS_PORT": str(REDIS_PORT),
            },
            # Note: volumes for tokens/voices should be configured by user
            # or built into the ASR image
        )
        
        return {
            "status": "success",
            "message": f"Container '{config.name}' started successfully",
            "container_id": container.short_id,
            "command": command
        }
        
    except docker.errors.ImageNotFound:
        return {
            "status": "error",
            "message": f"Image '{ASR_IMAGE}' not found. Run manually:",
            "command": command
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to start container: {str(e)}",
            "command": command
        }


@app.get("/api/containers")
def list_containers():
    """List all ASR-related containers"""
    docker_client = get_docker()
    
    if not docker_client:
        return {"containers": [], "docker_available": False}
    
    try:
        containers = docker_client.containers.list(all=True)
        
        result = []
        for c in containers:
            if c.name.startswith("asr-") or c.name.startswith("mock-"):
                result.append({
                    "id": c.short_id,
                    "name": c.name,
                    "status": c.status,
                    "image": c.image.tags[0] if c.image.tags else "unknown",
                    "created": c.attrs["Created"]
                })
        
        return {"containers": result, "docker_available": True}
        
    except Exception as e:
        return {"containers": [], "error": str(e), "docker_available": True}


@app.post("/api/containers/{container_name}/stop")
def stop_container(container_name: str):
    """Stop a container"""
    docker_client = get_docker()
    
    if not docker_client:
        return {"status": "error", "message": "Docker not available"}
    
    try:
        container = docker_client.containers.get(container_name)
        container.stop()
        return {"status": "success", "message": f"Container '{container_name}' stopped"}
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail=f"Container '{container_name}' not found")
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/containers/{container_name}/start")
def start_container(container_name: str):
    """Start a stopped container"""
    docker_client = get_docker()
    
    if not docker_client:
        return {"status": "error", "message": "Docker not available"}
    
    try:
        container = docker_client.containers.get(container_name)
        container.start()
        return {"status": "success", "message": f"Container '{container_name}' started"}
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail=f"Container '{container_name}' not found")
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.delete("/api/containers/{container_name}")
def remove_container(container_name: str):
    """Remove a container"""
    docker_client = get_docker()
    
    if not docker_client:
        return {"status": "error", "message": "Docker not available"}
    
    try:
        container = docker_client.containers.get(container_name)
        container.remove(force=True)
        return {"status": "success", "message": f"Container '{container_name}' removed"}
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail=f"Container '{container_name}' not found")
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/containers/{container_name}/logs")
def get_container_logs(container_name: str, tail: int = 100):
    """Get container logs"""
    docker_client = get_docker()
    
    if not docker_client:
        return {"status": "error", "message": "Docker not available"}
    
    try:
        container = docker_client.containers.get(container_name)
        logs = container.logs(tail=tail, timestamps=True).decode("utf-8")
        return {"logs": logs}
    except docker.errors.NotFound:
        raise HTTPException(status_code=404, detail=f"Container '{container_name}' not found")
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ============ Mock ASR ============

@app.get("/api/mock/status")
def get_mock_status():
    """Check if mock ASR is running"""
    docker_client = get_docker()
    
    if docker_client:
        try:
            container = docker_client.containers.get("asr-mock")
            return {
                "running": container.status == "running",
                "status": container.status,
                "container_id": container.short_id
            }
        except docker.errors.NotFound:
            pass
    
    r = get_redis()
    entries = r.xrevrange("tokens_updates_stream", count=5)
    
    mock_active = False
    last_activity = None
    
    for msg_id, data in entries:
        if data.get("container_id") == "mock-asr":
            mock_active = True
            timestamp_ms = int(msg_id.split("-")[0])
            last_activity = timestamp_ms
            break
    
    if last_activity:
        current_ms = int(time.time() * 1000)
        if current_ms - last_activity > 10000:
            mock_active = False
    
    return {
        "running": mock_active,
        "last_activity": last_activity
    }


@app.post("/api/mock/start")
def start_mock():
    """Start mock ASR container"""
    docker_client = get_docker()
    
    command = "docker-compose --profile mock up -d mock-asr"
    
    if not docker_client:
        return {
            "status": "info",
            "message": "Docker not available from backend. Run manually:",
            "command": command
        }
    
    try:
        try:
            existing = docker_client.containers.get("asr-mock")
            if existing.status == "running":
                return {
                    "status": "info",
                    "message": "Mock ASR is already running",
                    "container_id": existing.short_id
                }
            else:
                existing.start()
                return {
                    "status": "success",
                    "message": "Mock ASR started",
                    "container_id": existing.short_id
                }
        except docker.errors.NotFound:
            return {
                "status": "info",
                "message": "Run this command to start Mock ASR:",
                "command": command
            }
            
    except Exception as e:
        return {
            "status": "error",
            "message": str(e),
            "command": command
        }


@app.post("/api/mock/stop")
def stop_mock():
    """Stop mock ASR container"""
    docker_client = get_docker()
    
    if not docker_client:
        return {
            "status": "info",
            "message": "Run this command to stop Mock ASR:",
            "command": "docker-compose --profile mock stop mock-asr"
        }
    
    try:
        container = docker_client.containers.get("asr-mock")
        container.stop()
        return {"status": "success", "message": "Mock ASR stopped"}
    except docker.errors.NotFound:
        return {"status": "info", "message": "Mock ASR is not running"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ============ Portainer Integration ============

import httpx

class PortainerConfig(BaseModel):
    portainer_url: str  # e.g. "http://localhost:9000"
    api_token: str
    endpoint_id: int = 1  # Usually 1 for local
    
class PortainerLaunchConfig(BaseModel):
    portainer_url: str
    api_token: str
    endpoint_id: int = 1
    # Container config
    container_name: str
    image: str
    network_mode: str = "bridge"
    environment: dict = {}
    command: List[str] = []
    volumes: dict = {}  # host_path: container_path
    restart_policy: str = "no"
    use_gpu: bool = False  # Use nvidia runtime

@app.post("/api/portainer/test")
async def test_portainer_connection(config: PortainerConfig):
    """Test connection to Portainer API"""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{config.portainer_url}/api/endpoints",
                headers={"X-API-Key": config.api_token}
            )
            
            if response.status_code == 200:
                endpoints = response.json()
                return {
                    "status": "success",
                    "message": f"Connected! Found {len(endpoints)} endpoint(s)",
                    "endpoints": [{"id": e["Id"], "name": e["Name"]} for e in endpoints]
                }
            elif response.status_code == 401:
                return {"status": "error", "message": "Invalid API token"}
            else:
                return {"status": "error", "message": f"HTTP {response.status_code}: {response.text}"}
    except httpx.ConnectError:
        return {"status": "error", "message": f"Cannot connect to {config.portainer_url}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/api/portainer/containers")
async def list_portainer_containers(
    portainer_url: str,
    api_token: str,
    endpoint_id: int = 1
):
    """List containers via Portainer API"""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{portainer_url}/api/endpoints/{endpoint_id}/docker/containers/json?all=true",
                headers={"X-API-Key": api_token}
            )
            
            if response.status_code == 200:
                containers = response.json()
                result = []
                for c in containers:
                    result.append({
                        "id": c["Id"][:12],
                        "name": c["Names"][0].lstrip("/") if c["Names"] else "unknown",
                        "image": c["Image"],
                        "state": c["State"],
                        "status": c["Status"]
                    })
                return {"status": "success", "containers": result}
            else:
                return {"status": "error", "message": f"HTTP {response.status_code}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/portainer/launch")
async def launch_via_portainer(config: PortainerLaunchConfig):
    """Launch a container via Portainer API"""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Prepare container config for Docker API
            host_config = {
                "NetworkMode": config.network_mode,
                "RestartPolicy": {"Name": config.restart_policy},
                "Binds": [f"{h}:{c}" for h, c in config.volumes.items()] if config.volumes else []
            }
            
            # Add GPU support if requested
            if config.use_gpu:
                host_config["Runtime"] = "nvidia"
                host_config["DeviceRequests"] = [
                    {"Driver": "nvidia", "Count": -1, "Capabilities": [["gpu"]]}
                ]
            
            container_config = {
                "Image": config.image,
                "Env": [f"{k}={v}" for k, v in config.environment.items()],
                "HostConfig": host_config
            }
            
            if config.command:
                container_config["Cmd"] = config.command
            
            # Create container
            # Portainer parameter: pullImage=false to skip pulling from registry
            create_url = f"{config.portainer_url}/api/endpoints/{config.endpoint_id}/docker/containers/create"
            
            print(f"[Portainer] Creating container: {config.container_name}")
            print(f"[Portainer] Image: {config.image}")
            print(f"[Portainer] URL: {create_url}")
            
            create_response = await client.post(
                create_url,
                params={"name": config.container_name},
                headers={
                    "X-API-Key": config.api_token, 
                    "Content-Type": "application/json",
                    "X-Registry-Auth": ""  # Empty to skip registry auth/pull
                },
                json=container_config
            )
            
            print(f"[Portainer] Response status: {create_response.status_code}")
            print(f"[Portainer] Response body: {create_response.text[:500]}")
            
            if create_response.status_code in [200, 201]:
                container_id = create_response.json().get("Id", "")[:12]
                
                # Start container
                start_url = f"{config.portainer_url}/api/endpoints/{config.endpoint_id}/docker/containers/{container_id}/start"
                print(f"[Portainer] Starting container: {start_url}")
                
                start_response = await client.post(
                    start_url,
                    headers={"X-API-Key": config.api_token}
                )
                
                print(f"[Portainer] Start response status: {start_response.status_code}")
                print(f"[Portainer] Start response body: {start_response.text[:200] if start_response.text else 'empty'}")
                
                if start_response.status_code in [200, 204]:
                    return {
                        "status": "success",
                        "message": f"Container '{config.container_name}' started!",
                        "container_id": container_id
                    }
                else:
                    return {
                        "status": "error",
                        "message": f"Container created but failed to start: HTTP {start_response.status_code} - {start_response.text}"
                    }
            elif create_response.status_code == 409:
                return {"status": "error", "message": f"Container '{config.container_name}' already exists"}
            elif create_response.status_code == 404:
                return {"status": "error", "message": f"Image '{config.image}' not found. Pull it first."}
            else:
                return {"status": "error", "message": f"HTTP {create_response.status_code}: {create_response.text}"}
                
    except httpx.ConnectError:
        return {"status": "error", "message": f"Cannot connect to Portainer at {config.portainer_url}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/portainer/stop/{container_name}")
async def stop_via_portainer(
    container_name: str,
    portainer_url: str,
    api_token: str,
    endpoint_id: int = 1
):
    """Stop and remove a container via Portainer API"""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # First get container ID by name
            list_response = await client.get(
                f"{portainer_url}/api/endpoints/{endpoint_id}/docker/containers/json?all=true&filters={{\"name\":[\"{container_name}\"]}}",
                headers={"X-API-Key": api_token}
            )
            
            if list_response.status_code != 200:
                return {"status": "error", "message": "Failed to list containers"}
            
            containers = list_response.json()
            if not containers:
                return {"status": "error", "message": f"Container '{container_name}' not found"}
            
            container_id = containers[0]["Id"]
            
            # Stop container
            stop_response = await client.post(
                f"{portainer_url}/api/endpoints/{endpoint_id}/docker/containers/{container_id}/stop",
                headers={"X-API-Key": api_token}
            )
            
            # Remove container (force=true to remove even if running)
            remove_response = await client.delete(
                f"{portainer_url}/api/endpoints/{endpoint_id}/docker/containers/{container_id}?force=true",
                headers={"X-API-Key": api_token}
            )
            
            if remove_response.status_code in [200, 204]:
                return {"status": "success", "message": f"Container '{container_name}' stopped and removed"}
            elif stop_response.status_code in [204, 304]:
                return {"status": "success", "message": f"Container '{container_name}' stopped (but not removed)"}
            else:
                return {"status": "error", "message": f"HTTP {stop_response.status_code}"}
                
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ============ TOKENS API (Kalshi/Polymarket) ============

import requests
from bs4 import BeautifulSoup
import re

def fetch_kalshi_events(filter_text: str = None):
    """Fetch events from Kalshi API with proper filtering."""
    events = []
    
    # If no filter - return empty (user must search for something)
    if not filter_text or len(filter_text.strip()) < 2:
        print("[KALSHI] No filter provided, skipping search")
        return []
    
    filter_lower = filter_text.lower().strip()
    print(f"[KALSHI] Searching for: '{filter_lower}'")
    
    # Strategy 1: Search all open events and filter by title/ticker
    try:
        search_url = "https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200"
        response = requests.get(search_url, timeout=15)
        if response.status_code == 200:
            data = response.json()
            for event in data.get('events', []):
                title = event.get('title', '')
                ticker = event.get('event_ticker', '')
                # STRICT filter - must match
                if filter_lower in title.lower() or filter_lower in ticker.lower():
                    events.append({
                        "id": ticker,
                        "title": title,
                        "source": "kalshi",
                        "data": event
                    })
            print(f"[KALSHI] Strategy 1 found {len(events)} events")
    except Exception as e:
        print(f"[KALSHI] Search API error: {e}")
    
    # Strategy 2: Try category Mentions with STRICT filter
    try:
        url = "https://api.elections.kalshi.com/v1/search/series?order_by=trending&status=open%2Cunopened&category=Mentions&page_size=50"
        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            data = response.json()
            series_list = data.get('current_page', [])
            
            for series in series_list:
                title = series.get('event_title', series.get('series_title', ''))
                series_id = series.get('series_ticker', '')
                
                # STRICT filter - must match title or ticker
                if filter_lower not in title.lower() and filter_lower not in series_id.lower():
                    continue
                
                # Avoid duplicates
                if not any(e['id'] == series_id for e in events):
                    events.append({
                        "id": series_id,
                        "title": title,
                        "source": "kalshi",
                        "data": series
                    })
            print(f"[KALSHI] Strategy 2 total events: {len(events)}")
    except Exception as e:
        print(f"[KALSHI] Category API error: {e}")
    
    # Strategy 3: Try direct series pattern based on filter (not hardcoded!)
    mention_patterns = [
        f"KX{filter_text.upper()}MENTION",
        f"KX{filter_text.upper()}SAY",
        f"KX{filter_text.upper()}SAYMONTH",
    ]
    
    for pattern in mention_patterns:
        try:
            url = f"https://api.elections.kalshi.com/trade-api/v2/events?status=open&series_ticker={pattern}&with_nested_markets=true"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                data = response.json()
                for event in data.get('events', []):
                    event_id = event.get('event_ticker', '')
                    title = event.get('title', '')
                    if not any(e['id'] == event_id for e in events):
                        events.append({
                            "id": event_id,
                            "title": title,
                            "source": "kalshi",
                            "data": event
                        })
        except Exception as e:
            print(f"[KALSHI] Series {pattern} error: {e}")
    
    print(f"[KALSHI] Total events found: {len(events)}")
    return events


def get_polymarket_build_id():
    """Get current Polymarket build ID."""
    try:
        url = "https://polymarket.com/mentions"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        
        match = re.search(r'"buildId":"([^"]+)"', response.text)
        if match:
            return match.group(1)
        return None
    except Exception as e:
        print(f"Polymarket build ID error: {e}")
        return None


def fetch_polymarket_events(filter_text: str = None):
    """Fetch events from Polymarket - search ALL categories with mention priority."""
    events = []
    seen_slugs = set()
    
    # If no filter - return empty
    if not filter_text or len(filter_text.strip()) < 2:
        print("[POLYMARKET] No filter provided, skipping search")
        return []
    
    filter_lower = filter_text.lower().strip()
    print(f"[POLYMARKET] Searching for: '{filter_lower}'")
    
    # Strategy 1: Search for MENTION-type events first (what will X say)
    mention_searches = [
        f"{filter_text} say",
        f"{filter_text} mention", 
        f"{filter_text} word",
        f"{filter_text} state of the union",
        f"what will {filter_text}",
    ]
    
    for search_term in mention_searches:
        try:
            url = f"https://gamma-api.polymarket.com/events?closed=false&limit=50&title_contains={search_term}"
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                events_list = response.json()
                for event in events_list:
                    title = event.get('title', '')
                    slug = event.get('slug', '')
                    if slug and slug not in seen_slugs:
                        seen_slugs.add(slug)
                        events.append({
                            "id": slug,
                            "title": title,
                            "source": "polymarket",
                            "data": event,
                            "is_mention": True  # Mark as mention event
                        })
        except Exception as e:
            print(f"[POLYMARKET] Mention search '{search_term}' error: {e}")
    
    print(f"[POLYMARKET] Found {len(events)} mention events")
    
    # Strategy 2: Search ALL events
    try:
        url = f"https://gamma-api.polymarket.com/events?closed=false&limit=200"
        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            events_list = response.json()
            print(f"[POLYMARKET] Got {len(events_list)} total events")
            for event in events_list:
                title = event.get('title', '')
                slug = event.get('slug', '')
                description = event.get('description', '')
                
                # STRICT filter - must match title or description
                search_text = f"{title} {description}".lower()
                if filter_lower in search_text and slug and slug not in seen_slugs:
                    seen_slugs.add(slug)
                    events.append({
                        "id": slug,
                        "title": title,
                        "source": "polymarket",
                        "data": event,
                        "is_mention": False
                    })
    except Exception as e:
        print(f"[POLYMARKET] All events error: {e}")
    
    # Strategy 3: Direct title search
    try:
        url = f"https://gamma-api.polymarket.com/events?closed=false&limit=100&title_contains={filter_text}"
        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            events_list = response.json()
            for event in events_list:
                title = event.get('title', '')
                slug = event.get('slug', '')
                if filter_lower in title.lower() and slug and slug not in seen_slugs:
                    seen_slugs.add(slug)
                    events.append({
                        "id": slug,
                        "title": title,
                        "source": "polymarket",
                        "data": event,
                        "is_mention": False
                    })
    except Exception as e:
        print(f"[POLYMARKET] Title search error: {e}")
    
    print(f"[POLYMARKET] Total events found: {len(events)}")
    return events


def fetch_kalshi_event_markets(series_ticker: str):
    """Fetch markets for a Kalshi event - try multiple API endpoints."""
    all_markets = []
    
    # Strategy 1: Try v1 series API
    try:
        url = f"https://api.elections.kalshi.com/v1/events/?series_ticker={series_ticker}"
        response = requests.get(url, timeout=15)
        if response.status_code == 200:
            data = response.json()
            events = data.get('events', [])
            
            for event in events:
                markets = event.get('markets', [])
                event_ticker = event.get('event_ticker', '')
                
                for market in markets:
                    if market.get('status') == 'finalized':
                        continue
                    
                    ticker_name = market.get('ticker_name', '')
                    custom_strike = market.get('custom_strike', {})
                    
                    if isinstance(custom_strike, dict):
                        word = custom_strike.get('Word', '')
                    elif isinstance(custom_strike, str):
                        word = custom_strike
                    else:
                        word = market.get('yes_subtitle', '')
                    
                    if not ticker_name:
                        continue
                    
                    # Use ticker_name as word if word is empty
                    if not word:
                        word = ticker_name.split('-')[-1].replace('_YES', '').replace('_NO', '')
                    
                    # Parse count
                    match = re.match(r'^(.*?)\s*\((\d+)\+\s*times?\)$', word, re.IGNORECASE)
                    if match:
                        word_clean = match.group(1).strip().lower()
                        count = int(match.group(2))
                    else:
                        word_clean = word.strip().lower()
                        count = 1
                    
                    all_markets.append({
                        "word": word_clean,
                        "count": count,
                        "token_id": ticker_name,
                        "source": event_ticker
                    })
    except Exception as e:
        print(f"Kalshi v1 API error: {e}")
    
    # Strategy 2: Try v2 events API if v1 didn't work well
    if len(all_markets) == 0:
        try:
            url = f"https://api.elections.kalshi.com/trade-api/v2/events/{series_ticker}"
            response = requests.get(url, timeout=15)
            if response.status_code == 200:
                data = response.json()
                event = data.get('event', {})
                markets = event.get('markets', [])
                
                for market in markets:
                    if market.get('status') == 'finalized':
                        continue
                    
                    ticker = market.get('ticker', '')
                    title = market.get('title', '')
                    subtitle = market.get('yes_sub_title', market.get('subtitle', ''))
                    
                    if not ticker:
                        continue
                    
                    # Extract word from title/subtitle
                    word = subtitle if subtitle else title
                    if not word:
                        word = ticker.split('-')[-1].replace('_YES', '').replace('_NO', '')
                    
                    # Parse count
                    match = re.match(r'^(.*?)\s*\((\d+)\+\s*times?\)$', word, re.IGNORECASE)
                    if match:
                        word_clean = match.group(1).strip().lower()
                        count = int(match.group(2))
                    else:
                        word_clean = word.strip().lower()
                        count = 1
                    
                    all_markets.append({
                        "word": word_clean,
                        "count": count,
                        "token_id": ticker,
                        "source": series_ticker
                    })
        except Exception as e:
            print(f"Kalshi v2 API error: {e}")
    
    # Strategy 3: Try markets list endpoint
    if len(all_markets) == 0:
        try:
            url = f"https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker={series_ticker}&status=open"
            response = requests.get(url, timeout=15)
            if response.status_code == 200:
                data = response.json()
                markets = data.get('markets', [])
                
                for market in markets:
                    ticker = market.get('ticker', '')
                    title = market.get('title', '')
                    subtitle = market.get('yes_sub_title', '')
                    
                    if not ticker:
                        continue
                    
                    word = subtitle if subtitle else title
                    if not word:
                        word = ticker.split('-')[-1].replace('_YES', '').replace('_NO', '')
                    
                    match = re.match(r'^(.*?)\s*\((\d+)\+\s*times?\)$', word, re.IGNORECASE)
                    if match:
                        word_clean = match.group(1).strip().lower()
                        count = int(match.group(2))
                    else:
                        word_clean = word.strip().lower()
                        count = 1
                    
                    all_markets.append({
                        "word": word_clean,
                        "count": count,
                        "token_id": ticker,
                        "source": series_ticker
                    })
        except Exception as e:
            print(f"Kalshi markets API error: {e}")
    
    print(f"[KALSHI] Found {len(all_markets)} markets for {series_ticker}")
    return all_markets


def fetch_polymarket_event_markets(slug: str):
    """Fetch markets for a Polymarket event using gamma API."""
    try:
        print(f"[POLYMARKET] Fetching markets for slug: {slug}")
        
        # Use gamma API to get event details
        url = f"https://gamma-api.polymarket.com/events?slug={slug}"
        response = requests.get(url, timeout=15)
        response.raise_for_status()
        events = response.json()
        
        print(f"[POLYMARKET] Got {len(events)} events from API")
        
        if not events:
            return []
        
        event = events[0]  # Get first matching event
        markets = event.get('markets', [])
        
        print(f"[POLYMARKET] Event has {len(markets)} markets")
        
        all_markets = []
        pattern = r'["\u201c]([^"\u201d]+)["\u201d]'
        
        for market in markets:
            # Skip resolved markets
            if market.get('closed', False):
                continue
            
            question = market.get('question', '')
            
            # Get token_id - try multiple fields
            token_id = None
            
            # Try conditionId first (unique identifier)
            if market.get('conditionId'):
                token_id = market.get('conditionId')
            # Try id
            elif market.get('id'):
                token_id = market.get('id')
            # Try clobTokenIds (may be string or array)
            elif market.get('clobTokenIds'):
                clob = market.get('clobTokenIds')
                if isinstance(clob, list) and len(clob) > 0:
                    token_id = clob[0]
                elif isinstance(clob, str):
                    # Try to parse as JSON
                    try:
                        parsed = json.loads(clob)
                        if isinstance(parsed, list) and len(parsed) > 0:
                            token_id = parsed[0]
                    except:
                        pass
            
            print(f"[POLYMARKET] Market: {question[:50]}... token_id: {token_id}")
            
            if not token_id:
                continue
            
            # Extract words from question
            matches = re.findall(pattern, question)
            
            if not matches:
                # Fallback - use question start
                all_markets.append({
                    "word": question[:30],
                    "count": 1,
                    "token_id": token_id,
                    "source": slug
                })
                continue
            
            words = []
            for match in matches:
                match = match.strip().lower()
                if match and match not in ['or', 'and', ',', '/']:
                    match = re.sub(r'\s+or\s+', '/', match, flags=re.IGNORECASE)
                    match = re.sub(r'\s*/\s*', '/', match)
                    words.extend(w.strip() for w in match.split('/') if w.strip())
            
            if not words:
                all_markets.append({
                    "word": question[:30],
                    "count": 1,
                    "token_id": token_id,
                    "source": slug
                })
                continue
            
            # Extract count
            count_match = re.search(r'(\d+)\s*(?:times|\+)', question)
            count = int(count_match.group(1)) if count_match else 1
            
            all_markets.append({
                "word": '/'.join(words),
                "count": count,
                "token_id": token_id,
                "source": slug
            })
        
        print(f"[POLYMARKET] Returning {len(all_markets)} markets")
        return all_markets
    except Exception as e:
        print(f"Polymarket markets error: {e}")
        import traceback
        traceback.print_exc()
        return []


@app.get("/api/market-events")
def get_token_events(
    source: str = Query("both", description="kalshi, polymarket, or both"),
    filter: str = Query(None, description="Filter by title")
):
    """Get list of events from Kalshi and/or Polymarket."""
    events = []
    
    if source in ["kalshi", "both"]:
        events.extend(fetch_kalshi_events(filter))
    
    if source in ["polymarket", "both"]:
        events.extend(fetch_polymarket_events(filter))
    
    # Sort events - prioritize "mention" type events (say, mention, word, nickname)
    mention_keywords = ['say', 'mention', 'word', 'nickname', 'state of the union', 'what will']
    
    def get_priority(event):
        title = event.get('title', '').lower()
        event_id = event.get('id', '').lower()
        
        # Check if marked as mention event
        if event.get('is_mention'):
            return 0  # Highest priority
        
        # Check for mention keywords in title/id
        for keyword in mention_keywords:
            if keyword in title or keyword in event_id:
                return 1  # High priority
        return 2  # Lower priority
    
    events.sort(key=get_priority)
    
    return {"events": events, "count": len(events)}


def fetch_polymarket_mentions_events(filter_text: str = None):
    """Fetch ALL Mentions events from Polymarket - EXACTLY like interactive_fetch_tickers.py
    Filter is applied AFTER fetching, not during."""
    try:
        print("[POLYMARKET] Fetching mentions page...")
        
        # Get build ID
        build_id = get_polymarket_build_id()
        if not build_id:
            print("[POLYMARKET] Failed to get build ID")
            return []
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
        
        # Try JSON endpoint first
        data = None
        url = f"https://polymarket.com/_next/data/{build_id}/mentions.json"
        try:
            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()
            data = response.json()
            print("[POLYMARKET] Got data from JSON endpoint")
        except:
            data = None
        
        # If JSON endpoint didn't work, parse HTML directly
        if not data:
            from bs4 import BeautifulSoup
            url = "https://polymarket.com/mentions"
            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, "html.parser")
            script_tag = soup.find("script", {"id": "__NEXT_DATA__"})
            
            if not script_tag:
                print("[POLYMARKET] No __NEXT_DATA__ found in HTML")
                return []
            
            data = json.loads(script_tag.string)
            print("[POLYMARKET] Parsed HTML page")
        
        # Try to extract events using the old structure first
        queries = data.get('pageProps', {}).get('dehydratedState', {}).get('queries', [])
        events_list = None
        
        if queries and len(queries) > 0:
            state_data = queries[0].get('state', {}).get('data', {})
            pages = state_data.get('pages', [])
            if pages and len(pages) > 0:
                events_list = pages[0]
        
        # If old structure didn't work, try to find events recursively
        if not events_list:
            def find_events_recursive(obj, depth=0, max_depth=10):
                if depth > max_depth:
                    return None
                
                if isinstance(obj, dict):
                    for key in ['events', 'data', 'pages', 'results', 'items', 'list']:
                        if key in obj:
                            value = obj[key]
                            if isinstance(value, list) and len(value) > 0:
                                first_item = value[0]
                                if isinstance(first_item, dict):
                                    if 'slug' in first_item or 'title' in first_item:
                                        return value
                    
                    for value in obj.values():
                        result = find_events_recursive(value, depth + 1, max_depth)
                        if result is not None:
                            return result
                            
                elif isinstance(obj, list):
                    if len(obj) > 0:
                        first_item = obj[0]
                        if isinstance(first_item, dict):
                            if 'slug' in first_item or 'title' in first_item:
                                if len(obj) > 1 or ('slug' in first_item and 'title' in first_item):
                                    return obj
                        for item in obj:
                            result = find_events_recursive(item, depth + 1, max_depth)
                            if result is not None:
                                return result
                
                return None
            
            events_list = find_events_recursive(data)
        
        if not events_list:
            print("[POLYMARKET] No events found in response")
            return []
        
        print(f"[POLYMARKET] Found {len(events_list)} total mention events")
        
        # Convert to our format and apply filter
        result = []
        filter_lower = filter_text.lower() if filter_text else None
        
        for event in events_list:
            title = event.get('title', '')
            slug = event.get('slug', '')
            
            # Apply filter if provided (like filter_events in script)
            if filter_lower and filter_lower not in title.lower():
                continue
            
            result.append({
                'title': title,
                'slug': slug,
                '_source': 'polymarket'
            })
        
        print(f"[POLYMARKET] After filter '{filter_text}': {len(result)} events")
        return result
        
    except Exception as e:
        print(f"[POLYMARKET] Error: {e}")
        import traceback
        traceback.print_exc()
        return []


def fetch_polymarket_event_details(slug: str):
    """Fetch detailed market data for a Polymarket event."""
    try:
        from bs4 import BeautifulSoup
        url = f"https://polymarket.com/event/{slug}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
        
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, "html.parser")
        script_tag = soup.find("script", {"id": "__NEXT_DATA__"})
        
        if not script_tag:
            return None
        
        data = json.loads(script_tag.string)
        
        # Find markets recursively
        def find_markets_recursive(obj):
            if isinstance(obj, dict):
                if 'markets' in obj:
                    return obj['markets']
                for value in obj.values():
                    result = find_markets_recursive(value)
                    if result is not None:
                        return result
            elif isinstance(obj, list):
                for item in obj:
                    result = find_markets_recursive(item)
                    if result is not None:
                        return result
            return None
        
        return find_markets_recursive(data)
        
    except Exception as e:
        print(f"[POLYMARKET] Event details error for {slug}: {e}")
        return None


def fetch_kalshi_mentions_events(filter_text: str = None):
    """Fetch Mentions events from Kalshi API."""
    try:
        print("[KALSHI] Fetching mentions events...")
        url = "https://api.elections.kalshi.com/v1/search/series?order_by=trending&status=open%2Cunopened&category=Mentions&page_size=50&with_milestones=true"
        
        response = requests.get(url, timeout=15)
        response.raise_for_status()
        data = response.json()
        
        series_list = data.get('current_page', [])
        print(f"[KALSHI] Found {len(series_list)} mention events")
        
        # Filter by text if provided
        result = []
        filter_lower = filter_text.lower() if filter_text else None
        
        for series in series_list:
            title = series.get('event_title', series.get('series_title', ''))
            event_ticker = series.get('event_ticker', '')
            
            if filter_lower and filter_lower not in title.lower() and filter_lower not in event_ticker.lower():
                continue
            
            result.append({
                'title': title,
                'event_ticker': event_ticker,
                'markets': series.get('markets', []),
                '_source': 'kalshi'
            })
        
        print(f"[KALSHI] After filter: {len(result)} events")
        return result
        
    except Exception as e:
        print(f"[KALSHI] Error: {e}")
        return []


@app.get("/api/search-tokens")
def search_tokens(
    source: str = Query("both", description="kalshi, polymarket, or both"),
    q: str = Query(..., description="Search query"),
    mentions_only: bool = Query(False, description="Only return mention/say type events")
):
    """Search and return all tokens/markets using same logic as interactive_fetch_tickers.py"""
    if not q or len(q.strip()) < 2:
        return {"tokens": [], "count": 0}
    
    query = q.strip()
    mention_keywords = ['say', 'mention', 'word', 'nickname', 'state of the union']
    
    print(f"[SEARCH] Searching for: '{query}', mentions_only: {mentions_only}")
    
    all_tokens = []
    all_events = []
    
    # Fetch events from both sources
    if source in ["kalshi", "both"]:
        kalshi_events = fetch_kalshi_mentions_events(query)
        all_events.extend(kalshi_events)
    
    if source in ["polymarket", "both"]:
        polymarket_events = fetch_polymarket_mentions_events(query)
        all_events.extend(polymarket_events)
    
    print(f"[SEARCH] Total events found: {len(all_events)}")
    
    # Process each event and extract tokens
    for event in all_events:
        event_source = event.get('_source')
        event_title = event.get('title', '')
        
        # Apply mentions_only filter
        if mentions_only:
            event_text = event_title.lower()
            if not any(kw in event_text for kw in mention_keywords):
                continue
        
        if event_source == 'kalshi':
            # Kalshi: markets already in response
            markets = event.get('markets', [])
            event_ticker = event.get('event_ticker', '')
            
            for market in markets:
                status = market.get('status')
                if status and status != 'active':
                    continue
                
                ticker = market.get('ticker', '')
                custom_strike = market.get('custom_strike', {})
                
                if isinstance(custom_strike, dict):
                    word = custom_strike.get('Word', '')
                elif isinstance(custom_strike, str):
                    word = custom_strike
                else:
                    word = market.get('yes_subtitle', '')
                
                if not ticker:
                    continue
                
                # Parse count from word
                match = re.match(r'^(.*?)\s*\((\d+)\+\s*times?\)$', word, re.IGNORECASE)
                if match:
                    word_clean = match.group(1).strip()
                    count = int(match.group(2))
                else:
                    word_clean = word.strip() if word else ticker.split('-')[-1]
                    count = 1
                
                all_tokens.append({
                    "token_id": ticker,
                    "title": word_clean or event_title,
                    "event": event_title,
                    "source": "kalshi",
                    "count": count
                })
        
        elif event_source == 'polymarket':
            # Polymarket: ALWAYS fetch details for each event (like in script)
            slug = event.get('slug', '')
            
            if not slug:
                continue
            
            print(f"[POLYMARKET] Fetching details for: {slug}")
            markets = fetch_polymarket_event_details(slug)
            
            if not markets:
                print(f"[POLYMARKET] No markets found for {slug}")
                continue
            
            print(f"[POLYMARKET] Got {len(markets)} markets for {slug}")
            
            # Pattern for extracting words in quotes (exactly like script)
            quote_pattern = r'["\u201c]([^"\u201d]+)["\u201d]'
            
            for market in markets:
                # Check if resolved
                resolution_data = market.get('resolutionData')
                if resolution_data and resolution_data.get('status') == "resolved":
                    continue
                
                question = market.get('question', '')
                clob_token_ids = market.get('clobTokenIds', [])
                
                # Get token_id - exactly like script: clob_token_ids[0] if clob_token_ids else None
                token_id = clob_token_ids[0] if clob_token_ids else None
                
                if not token_id or not question:
                    continue
                
                # Extract words in quotes (exactly like script)
                matches = re.findall(quote_pattern, question)
                if not matches:
                    continue
                
                all_words = []
                for match in matches:
                    match_stripped = match.strip()
                    if not match_stripped or match_stripped.lower() in ['or', 'and', ',', '/']:
                        continue
                    
                    # Normalize separators (exactly like script)
                    normalized = match_stripped
                    normalized = re.sub(r'\s+or\s+', '/', normalized, flags=re.IGNORECASE)
                    normalized = re.sub(r'\s*/\s*', '/', normalized)
                    
                    # Split by /
                    words_in_match = normalized.split('/')
                    all_words.extend(word.strip().lower() for word in words_in_match if word.strip())
                
                if not all_words:
                    continue
                
                words = '/'.join(all_words)
                
                # Extract count from question (exactly like script)
                count_pattern = r'"([^"]+)".*?(\d+)\s*(?:times|\+)'
                count_match = re.search(count_pattern, question)
                count = int(count_match.group(2)) if count_match else 1
                
                all_tokens.append({
                    "token_id": token_id,
                    "title": words,
                    "event": event_title,
                    "source": "polymarket",
                    "count": count
                })
    
    # Sort - mention events first
    def get_priority(token):
        title = token.get('title', '').lower()
        event = token.get('event', '').lower()
        text = f"{title} {event}"
        
        for keyword in mention_keywords:
            if keyword in text:
                return 0
        return 1
    
    all_tokens.sort(key=get_priority)
    
    print(f"[SEARCH] Total tokens found: {len(all_tokens)}")
    return {"tokens": all_tokens, "count": len(all_tokens), "events_count": len(all_events)}


class TokensDirectSaveRequest(BaseModel):
    tokens: List[dict]  # [{token_id, word, source, event}, ...]


@app.post("/api/market-events/save-tokens")
def save_tokens_direct(request: TokensDirectSaveRequest):
    """Save tokens directly to Redis (without fetching from events)."""
    r = get_redis()
    
    saved = 0
    for token in request.tokens:
        token_id = token.get("token_id")
        word = token.get("word", "")
        source = token.get("source", "")
        event = token.get("event", "")  # Save event name for grouping
        
        if not token_id:
            continue
        
        print(f"[SAVE] Saving token: {token_id}, event: {event}")
        
        r.hset("tokens", token_id, "1")
        r.hset("tokens_info", token_id, json.dumps({
            "token_id": token_id,
            "word": word,
            "source": source,
            "event": event  # Include event in saved data
        }))
        saved += 1
    
    return {"status": "success", "saved": saved}


class TokenUpdateRequest(BaseModel):
    word: str = None
    event: str = None


@app.patch("/api/tokens/{token_id:path}")
def update_token(token_id: str, request: TokenUpdateRequest):
    """Update a token's word or event in Redis."""
    r = get_redis()
    
    # Get current token info
    token_info_raw = r.hget("tokens_info", token_id)
    if not token_info_raw:
        return {"status": "error", "message": "Token not found"}
    
    try:
        token_info = json.loads(token_info_raw)
    except:
        token_info = {"token_id": token_id}
    
    # Update fields
    if request.word is not None:
        token_info["word"] = request.word
    if request.event is not None:
        token_info["event"] = request.event
    
    # Save back
    r.hset("tokens_info", token_id, json.dumps(token_info))
    
    print(f"[UPDATE] Token {token_id}: word='{request.word}'")
    
    return {"status": "success", "token_id": token_id, "updated": token_info}


@app.get("/api/market-events/{source}/{event_id:path}")
def get_event_markets(source: str, event_id: str):
    """Get markets (tokens) for a specific event."""
    if source == "kalshi":
        markets = fetch_kalshi_event_markets(event_id)
    elif source == "polymarket":
        markets = fetch_polymarket_event_markets(event_id)
    else:
        return {"error": "Invalid source"}
    
    return {"markets": markets, "count": len(markets)}


class TokensSaveRequest(BaseModel):
    events: List[dict]  # [{source, id}, ...]


@app.post("/api/market-events/save")
def save_tokens_to_redis(request: TokensSaveRequest):
    """Fetch markets for selected events and save to Redis."""
    r = get_redis()
    
    all_tokens = []
    
    for event in request.events:
        source = event.get("source")
        event_id = event.get("id")
        
        print(f"[SAVE] Processing event: {source} / {event_id}")
        
        if source == "kalshi":
            markets = fetch_kalshi_event_markets(event_id)
        elif source == "polymarket":
            markets = fetch_polymarket_event_markets(event_id)
        else:
            print(f"[SAVE] Unknown source: {source}")
            continue
        
        print(f"[SAVE] Found {len(markets)} markets")
        all_tokens.extend(markets)
    
    # Save to Redis in same format as customer: token_id -> "1"
    saved = 0
    for token in all_tokens:
        token_id = token.get("token_id")
        if token_id:
            # Format: TOKEN_ID -> "1" (same as customer's data)
            r.hset("tokens", token_id, "1")
            # Also save full info for Dashboard display
            r.hset("tokens_info", token_id, json.dumps(token))
            saved += 1
            print(f"[SAVE] Saved: {token_id} ({token.get('word', 'no word')})")
    
    return {"status": "success", "saved": saved, "total": len(all_tokens)}


@app.get("/api/market-events/saved")
def get_saved_tokens():
    """Get all tokens saved in Redis with full info."""
    r = get_redis()
    
    # Try to get from tokens_info first (has full data)
    tokens_info = r.hgetall("tokens_info")
    
    result = []
    
    if tokens_info:
        # Use tokens_info (new format with full data)
        for token_id, data in tokens_info.items():
            try:
                parsed = json.loads(data)
                parsed["token_id"] = token_id
                result.append(parsed)
            except:
                result.append({
                    "token_id": token_id,
                    "word": "",
                    "count": 1,
                    "source": ""
                })
    else:
        # Fallback to tokens (old format, just "1")
        tokens = r.hgetall("tokens")
        for token_id, data in tokens.items():
            result.append({
                "token_id": token_id,
                "word": "",
                "count": data,
                "source": ""
            })
    
    return {"tokens": result, "count": len(result)}


@app.delete("/api/market-events/token/{token_id:path}")
def delete_single_token(token_id: str):
    """Delete a single token from Redis."""
    r = get_redis()
    
    # Remove from tokens hash
    r.hdel("tokens", token_id)
    
    # Remove from tokens_info hash
    r.hdel("tokens_info", token_id)
    
    print(f"[TOKENS] Deleted token: {token_id}")
    return {"status": "success", "message": f"Token {token_id} deleted"}


@app.delete("/api/market-events/clear")
def clear_tokens():
    """Clear all tokens from Redis."""
    r = get_redis()
    r.delete("tokens")
    r.delete("tokens_info")
    return {"status": "success", "message": "Tokens cleared"}


@app.get("/api/exchange-orderbook/{source}/{token_id:path}")
def get_exchange_orderbook(source: str, token_id: str):
    """Fetch orderbook directly from Kalshi or Polymarket exchange."""
    try:
        if source == "kalshi":
            # Kalshi API - token_id is the ticker like KXTRUMPSAY-26FEB02-COOK
            url = f"https://api.elections.kalshi.com/trade-api/v2/markets/{token_id}/orderbook"
            print(f"[ORDERBOOK] Fetching Kalshi: {url}")
            
            response = requests.get(url, timeout=10)
            print(f"[ORDERBOOK] Kalshi response status: {response.status_code}")
            
            if response.status_code == 404:
                return {"error": "Market not found", "bids": [], "asks": []}
            
            response.raise_for_status()
            data = response.json()
            print(f"[ORDERBOOK] Kalshi data keys: {data.keys() if isinstance(data, dict) else 'not dict'}")
            
            orderbook = data.get('orderbook', {}) or {}
            print(f"[ORDERBOOK] Kalshi orderbook keys: {orderbook.keys() if isinstance(orderbook, dict) else type(orderbook)}")
            
            # Parse Kalshi format - handle both dict and list formats
            bids = []
            asks = []
            
            yes_book = orderbook.get('yes') or []
            no_book = orderbook.get('no') or []
            
            print(f"[ORDERBOOK] yes_book type: {type(yes_book)}, len: {len(yes_book) if hasattr(yes_book, '__len__') else 'N/A'}")
            if yes_book:
                print(f"[ORDERBOOK] yes_book[0] type: {type(yes_book[0]) if isinstance(yes_book, list) and len(yes_book) > 0 else 'N/A'}")
                print(f"[ORDERBOOK] yes_book sample: {yes_book[:2] if isinstance(yes_book, list) else yes_book}")
            
            # Kalshi format: yes/no are lists of [price, size] pairs
            if isinstance(yes_book, list):
                for item in yes_book:
                    if isinstance(item, list) and len(item) >= 2:
                        # Format: [price, size]
                        price = int(item[0])
                        size = int(item[1])
                        bids.append({"price": price, "size": size})
                    elif isinstance(item, dict):
                        bids.append({"price": int(item.get('price', 0)), "size": item.get('size', 0)})
            elif isinstance(yes_book, dict):
                for price_str, size in yes_book.items():
                    price = int(price_str)
                    bids.append({"price": price, "size": size})
            
            if isinstance(no_book, list):
                for item in no_book:
                    if isinstance(item, list) and len(item) >= 2:
                        # Format: [price, size] - convert no price to yes ask
                        price = int(item[0])
                        size = int(item[1])
                        asks.append({"price": 100 - price, "size": size})
                    elif isinstance(item, dict):
                        asks.append({"price": 100 - int(item.get('price', 0)), "size": item.get('size', 0)})
            elif isinstance(no_book, dict):
                for price_str, size in no_book.items():
                    price = int(price_str)
                    asks.append({"price": 100 - price, "size": size})
            
            # Sort: bids descending, asks ascending
            bids.sort(key=lambda x: x['price'], reverse=True)
            asks.sort(key=lambda x: x['price'])
            
            best_bid = bids[0]['price'] if bids else 0
            best_ask = asks[0]['price'] if asks else 100
            
            print(f"[ORDERBOOK] Parsed {len(bids)} bids, {len(asks)} asks")
            
            return {
                "source": "kalshi",
                "token_id": token_id,
                "bids": bids[:10],
                "asks": asks[:10],
                "best_bid": best_bid,
                "best_ask": best_ask
            }
            
        elif source == "polymarket":
            # Polymarket CLOB API - try gamma API first for market info
            print(f"[ORDERBOOK] Fetching Polymarket for token: {token_id[:50]}...")
            
            # Try CLOB API
            clob_url = f"https://clob.polymarket.com/book?token_id={token_id}"
            print(f"[ORDERBOOK] Trying CLOB: {clob_url}")
            
            response = requests.get(clob_url, timeout=10)
            print(f"[ORDERBOOK] CLOB response status: {response.status_code}")
            
            if response.status_code == 200:
                data = response.json()
                print(f"[ORDERBOOK] CLOB data keys: {data.keys() if isinstance(data, dict) else type(data)}")
                
                bids = []
                asks = []
                
                for bid in (data.get('bids') or []):
                    price = float(bid.get('price', 0)) * 100
                    size = float(bid.get('size', 0))
                    bids.append({"price": int(price), "size": int(size)})
                
                for ask in (data.get('asks') or []):
                    price = float(ask.get('price', 0)) * 100
                    size = float(ask.get('size', 0))
                    asks.append({"price": int(price), "size": int(size)})
                
                bids.sort(key=lambda x: x['price'], reverse=True)
                asks.sort(key=lambda x: x['price'])
                
                best_bid = bids[0]['price'] if bids else 0
                best_ask = asks[0]['price'] if asks else 100
                
                return {
                    "source": "polymarket",
                    "token_id": token_id,
                    "bids": bids[:10],
                    "asks": asks[:10],
                    "best_bid": best_bid,
                    "best_ask": best_ask
                }
            
            # If CLOB fails, try gamma API
            gamma_url = f"https://gamma-api.polymarket.com/markets?clob_token_ids={token_id}"
            print(f"[ORDERBOOK] Trying Gamma: {gamma_url}")
            
            response = requests.get(gamma_url, timeout=10)
            
            if response.status_code == 200:
                markets = response.json()
                if markets and len(markets) > 0:
                    market = markets[0]
                    # Get best bid/ask from market data
                    best_bid = int(float(market.get('bestBid', 0)) * 100)
                    best_ask = int(float(market.get('bestAsk', 0)) * 100)
                    
                    return {
                        "source": "polymarket",
                        "token_id": token_id,
                        "bids": [{"price": best_bid, "size": 0}] if best_bid else [],
                        "asks": [{"price": best_ask, "size": 0}] if best_ask else [],
                        "best_bid": best_bid,
                        "best_ask": best_ask,
                        "market_info": {
                            "question": market.get('question', ''),
                            "outcomePrices": market.get('outcomePrices', '')
                        }
                    }
            
            return {"error": "Market not found", "bids": [], "asks": []}
        else:
            return {"error": f"Unknown source: {source}"}
            
    except requests.exceptions.RequestException as e:
        print(f"[ORDERBOOK] Request error: {e}")
        return {"error": str(e), "bids": [], "asks": []}
    except Exception as e:
        print(f"[ORDERBOOK] Error: {e}")
        import traceback
        traceback.print_exc()
        return {"error": str(e), "bids": [], "asks": []}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
